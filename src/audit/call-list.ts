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
import { LATEST_CALL_FORMAT, READABLE_CALL_FORMATS } from './schema.js';
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

/** A non-negative integer offset; fractions and negatives fall back to zero. */
export function clampOffset(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return 0;
  return Math.max(Math.trunc(value), 0);
}

/**
 * The last page that still contains a row.
 *
 * Used when a window outlives the rows it showed — the page was cleared,
 * retention ran, or a filter narrowed the set: the reader is moved to the last
 * non-empty page instead of being shown an empty tail with a valid total.
 */
export function clampToLastPage(
  offset: number,
  total: number,
  limit: number,
): number {
  if (total <= 0) return 0;
  const page = clampPageSize(limit);
  return Math.min(clampOffset(offset), Math.floor((total - 1) / page) * page);
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
 * The anchor predicate: this traversal's rows are at or below it.
 *
 * Both halves are needed for a total bound. `<=` on `ts` alone would let a call
 * sharing the anchor's timestamp but sorting above it enter the set, which is
 * exactly the drift the anchor exists to prevent.
 */
function anchorPredicate(anchor: CallAnchor): Predicate {
  return {
    sql: '(ts < ? OR (ts = ? AND call_id <= ?))',
    values: [anchor.ts, anchor.ts, anchor.callId],
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
  anchor: CallAnchor | null,
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
    anchor === null ? null : anchorPredicate(anchor),
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
 * An unknown (newer) format is not an error and not a reason to hide the row:
 * the identifying fields are still what the list is for, and a record written by
 * a newer build must not vanish from browsing while it is still in SQLite.
 */
function versionOf(row: Record<string, unknown>): {
  readonly recordFormatVersion: number;
  readonly unreadable: boolean;
  readonly unreadableReason: string | null;
} {
  const raw = row['record_format_version'];
  const parsed = typeof raw === 'bigint' ? Number(raw) : Number(raw ?? 1);
  const version = Number.isFinite(parsed) ? parsed : 1;
  const readable = READABLE_CALL_FORMATS.includes(version);
  return {
    recordFormatVersion: version,
    unreadable: !readable,
    unreadableReason: readable
      ? null
      : `record format ${String(version)} is newer than this plugin (${String(LATEST_CALL_FORMAT)})`,
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

/** `WHERE` plus the anchor's extra condition, without the anchor predicate. */
function scopeOf(filter: CallFilter): {
  readonly scope: string;
  readonly values: (string | number)[];
} {
  const { where, values } = whereOf(filter, null);
  return { scope: where.length > 0 ? `${where} AND` : 'WHERE', values };
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
  const { where, values } = whereOf(filter, null);
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
  const { scope, values } = scopeOf(filter);
  const row = asRow(
    db
      .prepare(
        `SELECT COUNT(*) AS count FROM calls ${scope}
          (ts > ? OR (ts = ? AND call_id > ?))`,
      )
      .get(...values, anchor.ts, anchor.ts, anchor.callId),
  );
  return rowNumber(row['count']);
}

/** One page of calls, newest first, within a fixed traversal anchor. */
export function callPage(db: DatabaseSync, filter: CallFilter = {}): CallPage {
  // The anchor is resolved before the page read so the page and the "newer"
  // count describe the same traversal even if a write lands between them.
  const anchor = filter.anchor ?? newestAnchor(db, filter);
  const { where, values } = whereOf(filter, anchor);
  const limit = clampPageSize(filter.limit);
  const offset = clampOffset(filter.offset);
  const totalRow = asRow(
    db.prepare(`SELECT COUNT(*) AS count FROM calls ${where}`).get(...values),
  );
  const rows = asRows(
    db
      .prepare(
        `SELECT ${ROW_COLUMNS} FROM calls ${where}
          ORDER BY ts DESC, call_id DESC LIMIT ? OFFSET ?`,
      )
      .all(...values, limit, offset),
  );
  return {
    total: rowNumber(totalRow['count']),
    limit,
    offset,
    anchor,
    newer: anchor === null ? 0 : newerCount(db, filter, anchor),
    rows: rows.map(summaryOf),
  };
}
