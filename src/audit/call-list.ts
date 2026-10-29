/**
 * The paged call list: anchored paging, filter predicates and the narrow row.
 *
 * Three contracts live here.
 *
 * - **A traversal has a fixed upper bound.** `ORDER BY ts DESC` plus `OFFSET`
 *   alone is not a stable window: one call arriving above the reader's page
 *   shifts every row down, so the next page repeats a row and drops another.
 *   The fix is not a better sort key but an anchor — the newest record the
 *   traversal started at. Rows above the anchor are outside it, so the offset
 *   keeps meaning "the Nth row of the set I started reading".
 * - **A page is a total order.** `call_id` is the primary key, so
 *   `ts DESC, call_id DESC` is total; equal timestamps cannot swap places
 *   between two reads of the same page.
 * - **A page carries only what the list renders.** The reason, stage chain,
 *   arguments and model traffic belong to the detail read; selecting them here
 *   would put each call's full prompt and response into one page response.
 */
import type { DatabaseSync } from 'node:sqlite';
import type { CallAnchor, CallFilter, CallPage, CallSummary } from './types.js';
import { DENIED_RESULTS } from './types.js';
import { RECORD_FORMAT } from './schema.js';
import { asRow, asRows, rowNumber, rowText } from './rows.js';

/** The window a list request gets when it does not ask for one. */
export const DEFAULT_PAGE_SIZE = 25;
/** The smallest usable page. */
export const MIN_PAGE_SIZE = 1;
/** The largest page a single request may read. */
export const MAX_PAGE_SIZE = 200;

/**
 * The bound on a derived operation summary.
 *
 * Applied to the whole expression, not to its fallback branch: a stored
 * `command` can itself be hundreds of kilobytes (a record may be up to 8 MiB),
 * and returning it whole would make a "bounded page" unbounded in bytes.
 */
const SUMMARY_LENGTH = 240;

/**
 * A page size the store will actually read.
 *
 * The window is capped here rather than at the caller, so every list route
 * inherits the same bound and a request cannot widen its own read.
 */
export function clampPageSize(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return DEFAULT_PAGE_SIZE;
  return Math.min(Math.max(Math.trunc(value), MIN_PAGE_SIZE), MAX_PAGE_SIZE);
}

/** A predicate plus the values it binds, in placeholder order. */
interface Predicate {
  readonly sql: string;
  readonly values: readonly (string | number)[];
}

/** An optional column equality; an empty value means "not filtered". */
function equality(column: string, value: string | undefined): Predicate | null {
  return value === undefined || value.length === 0
    ? null
    : { sql: `${column} = ?`, values: [value] };
}

/** An optional numeric bound on a column. */
function bound(
  column: string,
  operator: string,
  value: number | undefined,
): Predicate | null {
  return value === undefined
    ? null
    : { sql: `${column} ${operator} ?`, values: [value] };
}

/**
 * The row's position in the newest-first order is strictly after `cursor`.
 *
 * The tie-break on `call_id` is what makes this a keyset rather than a
 * heuristic: the pair is unique, so "after this row" names an exact boundary no
 * insertion can move. A call inserted with a later timestamp, an earlier one, or
 * one sharing this timestamp and sorting above it all land on one side or the
 * other without shifting the rows already returned.
 */
function scopeAll(
  first: Predicate | null,
  second: Predicate | null,
): Predicate | null {
  if (first === null) return second;
  if (second === null) return first;
  return {
    sql: `(${first.sql}) AND (${second.sql})`,
    values: [...first.values, ...second.values],
  };
}

/** The row's position in the newest-first order is strictly after `cursor`. */
function afterCursor(cursor: CallAnchor): Predicate {
  return {
    sql: '(ts < ? OR (ts = ? AND call_id < ?))',
    values: [cursor.ts, cursor.ts, cursor.callId],
  };
}

/**
 * The traversal's upper bound: rows at or below its head.
 *
 * Used only for the total, so the pager counts the set the reader started with
 * rather than the rows still ahead of the cursor. Rows above the head are
 * arrivals, and they are reported separately as `newer`.
 */
function headBound(head: CallAnchor): Predicate {
  return {
    sql: '(ts < ? OR (ts = ? AND call_id <= ?))',
    values: [head.ts, head.ts, head.callId],
  };
}

/** The rows strictly before `cursor` in the same order (the "previous" read). */
function beforeCursor(cursor: CallAnchor): Predicate {
  return {
    sql: '(ts > ? OR (ts = ? AND call_id > ?))',
    values: [cursor.ts, cursor.ts, cursor.callId],
  };
}

/**
 * The rule filter, which has to read both sources.
 *
 * A rule short-circuit records the hit rule only in the `rule` trace stage; a
 * reviewed call records the reviewer's decision rules in `decision_rules`. Both
 * answer "which rule decided this", so either match counts.
 */
function rulePredicate(ruleId: string): Predicate {
  return {
    sql: `(EXISTS (SELECT 1 FROM json_each(decision_rules) WHERE value = ?)
        OR EXISTS (SELECT 1 FROM json_each(trace)
                    WHERE json_extract(value, '$.stage') = 'rule'
                      AND json_extract(value, '$.ruleId') = ?))`,
    values: [ruleId, ruleId],
  };
}

/** The review-failure shortcut: a review stage that reported `error-escalate`. */
const REVIEW_FAILURE: Predicate = {
  sql: `EXISTS (SELECT 1 FROM json_each(trace)
                WHERE json_extract(value, '$.stage') = 'review'
                  AND json_extract(value, '$.result') = 'error-escalate')`,
  values: [],
};

/** The denied shortcut, with one placeholder per verdict. */
function deniedPredicate(): Predicate {
  return {
    sql: `result IN (${DENIED_RESULTS.map(() => '?').join(', ')})`,
    values: DENIED_RESULTS,
  };
}

/**
 * Free text over the stored material and the identifying columns.
 *
 * The user's text is matched literally: `%` and `_` are LIKE wildcards, so an
 * operator searching for `100%` must not silently get every record starting with
 * `100`. `\` is LIKE's escape character here, so it is escaped first.
 */
function searchPredicate(query: string): Predicate {
  const escaped = query
    .replaceAll('\\', '\\\\')
    .replaceAll('%', '\\%')
    .replaceAll('_', '\\_');
  const like = `%${escaped}%`;
  return {
    sql: "(arguments LIKE ? ESCAPE '\\' OR reason LIKE ? ESCAPE '\\' OR tool LIKE ? ESCAPE '\\' OR session_id LIKE ? ESCAPE '\\')",
    values: [like, like, like, like],
  };
}

/**
 * Filter predicates, in SQL, so they apply before the window.
 *
 * Filtering in the reader instead would let rows the caller excluded consume
 * page slots and shorten every page after the first.
 */
function whereOf(
  filter: CallFilter,
  extra: Predicate | null = null,
): {
  readonly where: string;
  readonly values: (string | number)[];
} {
  const candidates: (Predicate | null)[] = [
    equality('result', filter.result),
    equality('tool', filter.tool),
    equality('session_id', filter.sessionId),
    equality('session_kind', filter.sessionKind),
    bound('ts', '>=', filter.from),
    bound('ts', '<=', filter.to),
    filter.ruleId === undefined || filter.ruleId.length === 0
      ? null
      : rulePredicate(filter.ruleId),
    filter.deniedOnly === true ? deniedPredicate() : null,
    filter.reviewFailureOnly === true ? REVIEW_FAILURE : null,
    filter.query === undefined || filter.query.length === 0
      ? null
      : searchPredicate(filter.query),
    extra,
  ];
  const applied = candidates.filter((item): item is Predicate => item !== null);
  return {
    where:
      applied.length > 0
        ? `WHERE ${applied.map((item) => item.sql).join(' AND ')}`
        : '',
    values: applied.flatMap((item) => [...item.values]),
  };
}

/**
 * The summary sources, in the order they are tried.
 *
 * `json_type = 'text'` rejects a number or object where a command belongs, and
 * the whole coalesce is truncated once at the end, so neither a non-string nor
 * an oversized value can leak into the page.
 */
const SUMMARY_EXPRESSION = `substr(COALESCE(
  CASE WHEN json_valid(arguments) AND json_type(arguments, '$.command') = 'text'
         THEN json_extract(arguments, '$.command') END,
  CASE WHEN json_valid(arguments) AND json_type(arguments, '$.code') = 'text'
         THEN json_extract(arguments, '$.code') END,
  substr(arguments, 1, ${String(SUMMARY_LENGTH)})
), 1, ${String(SUMMARY_LENGTH)})`;

/** The list row projection, including the bounded summary and rule identity. */
const ROW_COLUMNS = `call_id, ts, session_id, session_kind, tool, result,
  record_format_version, ${SUMMARY_EXPRESSION} AS command,
  (SELECT json_extract(value, '$.ruleId') FROM json_each(trace)
    WHERE json_extract(value, '$.stage') = 'rule' LIMIT 1) AS rule_id,
  (SELECT json_extract(value, '$.ruleName') FROM json_each(trace)
    WHERE json_extract(value, '$.stage') = 'rule' LIMIT 1) AS rule_name`;

/**
 * The format marker on a list row.
 *
 * A row this build did not write is not hidden: its identifying fields are still
 * what the list is for, and a record from another build must not vanish from
 * browsing while it is still in SQLite. It is reported as unreadable instead, so
 * no current semantics are claimed for it.
 */
function versionOf(row: Record<string, unknown>): {
  readonly recordFormatVersion: number | null;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
} {
  const raw = row['record_format_version'];
  // `Number(null)` is 0, so an absent value has to be excluded before conversion
  // or it would read as a written format nobody wrote.
  const parsed =
    typeof raw === 'number' || typeof raw === 'bigint' ? Number(raw) : null;
  const version = parsed !== null && Number.isFinite(parsed) ? parsed : null;
  const readable = version === RECORD_FORMAT;
  return {
    recordFormatVersion: version,
    unreadable: !readable,
    unreadableReason: readable
      ? null
      : version === null
        ? `this row declares no record format; only format ${String(RECORD_FORMAT)} is supported`
        : `record format ${String(version)} is not supported by this plugin (only ${String(RECORD_FORMAT)})`,
  };
}

function summaryOf(row: Record<string, unknown>): CallSummary {
  const ruleId = row['rule_id'];
  const ruleName = row['rule_name'];
  return {
    callId: rowText(row['call_id']),
    ts: rowNumber(row['ts']),
    sessionId: rowText(row['session_id']),
    sessionKind: rowText(row['session_kind'], 'main'),
    tool: rowText(row['tool']),
    command: rowText(row['command']),
    result: rowText(row['result']),
    ruleId: typeof ruleId === 'string' ? ruleId : null,
    ruleName: typeof ruleName === 'string' ? ruleName : null,
    ...versionOf(row),
  };
}

/** `WHERE` plus one extra condition, for the counts that need a cursor bound. */
function scopeOf(
  filter: CallFilter,
  extra: Predicate,
): { readonly scope: string; readonly values: (string | number)[] } {
  const { where, values } = whereOf(filter, extra);
  return { scope: where, values };
}

/**
 * The newest record matching a filter, used to start a traversal.
 *
 * Read once, when a request arrives without an anchor. A traversal that began
 * at "whatever is newest right now" and re-read that edge on every page would
 * have exactly the drift the anchor exists to remove.
 */
export function newestAnchor(
  db: DatabaseSync,
  filter: CallFilter,
): CallAnchor | null {
  const { where, values } = whereOf(filter);
  const row = asRow(
    db
      .prepare(
        `SELECT ts, call_id FROM calls ${where}
          ORDER BY ts DESC, call_id DESC LIMIT 1`,
      )
      .get(...values),
  );
  if (row['ts'] === undefined) return null;
  return { ts: rowNumber(row['ts']), callId: rowText(row['call_id']) };
}

/**
 * How many matching rows sit above this traversal's anchor.
 *
 * This is what "N new records" counts. A change in `total` cannot answer it: a
 * cleanup pass can delete as many rows as arrive, and the delta would be zero
 * while both happened.
 */
function newerCount(
  db: DatabaseSync,
  filter: CallFilter,
  anchor: CallAnchor,
): number {
  const { scope, values } = scopeOf(filter, beforeCursor(anchor));
  const row = asRow(
    db.prepare(`SELECT COUNT(*) AS count FROM calls ${scope}`).get(...values),
  );
  return rowNumber(row['count']);
}

/** Which side of the cursor a read covers, and the predicate that selects it. */
function windowOf(filter: CallFilter): {
  readonly backward: boolean;
  readonly tail: boolean;
  readonly extra: Predicate | null;
} {
  // `tail` names the oldest page without a cursor; it reads backwards from the
  // end of the traversal.
  const tail = filter.tail === true;
  const backward =
    tail || (filter.before !== undefined && filter.after === undefined);
  const cursor = tail ? null : (filter.before ?? filter.after ?? null);
  return {
    backward,
    tail,
    extra:
      cursor === null
        ? null
        : backward
          ? beforeCursor(cursor)
          : afterCursor(cursor),
  };
}

/**
 * How many rows follow `cursor` inside this traversal.
 *
 * The count is what lets a pager state the exact number of pages that remain
 * without deriving it from `total`: the total includes calls that arrived behind
 * the reader, and those must not become pages the traversal can reach.
 */
function remainingAfter(
  db: DatabaseSync,
  filter: CallFilter,
  cursor: Predicate,
  anchor: CallAnchor | null,
): number {
  const { where, values } = whereOf(
    filter,
    scopeAll(cursor, anchor === null ? null : headBound(anchor)),
  );
  const row = asRow(
    db.prepare(`SELECT COUNT(*) AS count FROM calls ${where}`).get(...values),
  );
  return rowNumber(row['count']);
}

/**
 * One page of calls, newest first, read from a keyset cursor.
 *
 * Two readers exist, and both are bounded by a row rather than a row count:
 *
 * - forward (`after`) returns the next page of a traversal;
 * - backward (`before`) returns the page before a cursor, reversed back into
 *   newest-first order for display.
 *
 * `total` and `newer` are counted against the whole filtered set and the
 * traversal head respectively, so neither is affected by which page was read.
 */
export function callPage(db: DatabaseSync, filter: CallFilter = {}): CallPage {
  // The head is resolved before the page read so the page and the arrival count
  // describe the same traversal even if a write lands between the two queries.
  const anchor = filter.anchor ?? newestAnchor(db, filter);
  const window = windowOf(filter);
  // The row query is bounded by the traversal head *and* the cursor. Applying the
  // head only to the count would let a refresh admit a call that arrived above
  // the head, replacing a row the reader had already been shown.
  const { where, values } = whereOf(
    filter,
    scopeAll(window.extra, anchor === null ? null : headBound(anchor)),
  );
  // The total is counted against the traversal, not the remaining window: the
  // pager needs a stable denominator, and a reader on page two must still see
  // the size of the set they started with.
  const totalScope = whereOf(
    filter,
    anchor === null ? null : headBound(anchor),
  );
  const limit = clampPageSize(filter.limit);
  const totalRow = asRow(
    db
      .prepare(`SELECT COUNT(*) AS count FROM calls ${totalScope.where}`)
      .get(...totalScope.values),
  );
  const total = rowNumber(totalRow['count']);
  // The backward read walks the order in reverse so LIMIT takes the rows
  // adjacent to the cursor; the reverse afterwards restores display order.
  const order = window.backward ? 'ASC' : 'DESC';
  // Reading backwards from the end takes the oldest rows; how many of them form
  // the last page depends on the total, not on the page size alone. The count is
  // derived here so `tail` names one exact page rather than a reversed window.
  const readCount = window.tail
    ? total - Math.floor(Math.max(total - 1, 0) / limit) * limit
    : limit;
  const read = asRows(
    db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM calls ${where}
          ORDER BY ts ${order}, call_id ${order} LIMIT ?`,
      )
      .all(...values, readCount),
  );
  const rows = (window.backward ? [...read].reverse() : read).map(summaryOf);
  // Continuation is decided by whether a row exists, not by arithmetic on a total
  // that insertions and cleanup can change: `index + limit < total` can open a
  // page that has no rows, and the correction then shows an already-read one.
  const continuation = rows[rows.length - 1];
  const remaining =
    continuation === undefined
      ? 0
      : remainingAfter(
          db,
          filter,
          afterCursor({ ts: continuation.ts, callId: continuation.callId }),
          anchor,
        );
  const first = rows[0];
  const last = rows[rows.length - 1];
  return {
    total,
    limit,
    rows,
    remaining,
    // A cursor exists only when the page has a row to continue from; how many
    // rows follow is reported by `remaining`, not inferred from `total`.
    nextCursor:
      last === undefined ? null : { ts: last.ts, callId: last.callId },
    prevCursor:
      first === undefined ? null : { ts: first.ts, callId: first.callId },
    anchor,
    newer: anchor === null ? 0 : newerCount(db, filter, anchor),
  };
}
