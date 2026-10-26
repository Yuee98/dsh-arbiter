/**
 * The log list's loading state: one page, one generation, one cursor.
 *
 * Extracted from the panel so the four rules that make paging correct live in
 * one place instead of being spread through a render function:
 *
 * - **A request generation decides who may commit.** A slow response for an old
 *   filter can arrive after a newer one; without the guard it would replace the
 *   rows while the controls still show the new filter.
 * - **A page continues from the last row read.** That is what keeps a reader on
 *   a historical page when a call arrives, even one whose timestamp sorts inside
 *   the window already read. Continuation is "a row follows", never arithmetic on
 *   the total.
 * - **Arrivals are counted, not inferred.** Only an explicit refresh asks how
 *   many matching calls sit above the traversal head; a total delta would also
 *   fire on a filter change, when nothing arrived.
 * - **A page that lost its rows is corrected once.** The correction reads the
 *   oldest page by name, which is the only position that still exists after a
 *   deletion from the tail, and it is bounded so shrinking storage cannot spin.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getJson } from './api.js';
import { logsResponse } from './decoders/logs.js';
import { useArbiterTranslation } from './i18n-provider.js';
import {
  FIRST_PAGE,
  LAST_PAGE,
  hasFilters,
  initialQuery,
  paramsOf,
} from './log-list.js';
import type { LogCursor, LogQuery } from './log-list.js';
import type { LogAnchor, LogRow } from './view-types.js';
import { errorText } from './view-helpers.js';

/** What one committed page response contains. */
export interface LoadedPage {
  readonly rows: readonly LogRow[];
  readonly total: number;
  readonly nextCursor: LogAnchor | null;
  readonly prevCursor: LogAnchor | null;
  /** How many matching rows follow this page, as the host counted them. */
  readonly remaining: number;
  readonly index: number;
}

/** How one read is positioned and why it was issued. */
export interface LoadOptions {
  /** The traversal head to keep, or null to start a new traversal. */
  readonly keepAnchor: LogAnchor | null;
  /** Rows the reader has passed before this page, for the position label. */
  readonly index: number;
  /** True for the one corrective read after a page lost its rows. */
  readonly corrected?: boolean;
  /** True only when the reader asked to see whether anything arrived. */
  readonly refresh?: boolean;
}

/**
 * One page the reader has already seen, kept so "previous" is a restore.
 *
 * The committed page carries its own total and remaining count, so replaying it
 * also replays the position and count the reader saw at that moment rather than
 * recomputing them from a set that has since changed.
 */
interface VisitedPage {
  readonly page: LoadedPage;
  readonly cursor: LogCursor;
  readonly anchor: LogAnchor | null;
}

export interface LogPages {
  readonly query: LogQuery;
  readonly draft: LogQuery;
  readonly loaded: LoadedPage | null;
  readonly error: string | null;
  readonly notice: { readonly count: number } | null;
  readonly busy: boolean;
  readonly emptyText: string;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  /** How many rows the reader has passed, for the pager's position label. */
  readonly index: number;
  readonly setDraft: (draft: LogQuery) => void;
  readonly applyFilters: () => void;
  readonly clearFilters: () => void;
  readonly refresh: () => void;
  readonly next: () => void;
  readonly previous: () => void;
  readonly backToLatest: () => void;
}

/**
 * The next page's cursor and position, or null at the end of the traversal.
 *
 * Kept outside the hook so the forward move is one decision rather than a branch
 * inside an event handler: the cursor comes from the row the reader last saw,
 * and the position advances by the rows actually displayed.
 */
export function forwardMove(page: LoadedPage): {
  readonly cursor: LogCursor;
  readonly index: number;
} | null {
  return page.nextCursor === null
    ? null
    : {
        cursor: { after: page.nextCursor, before: null, tail: false },
        index: page.index + page.rows.length,
      };
}

/** The previous page's cursor and position, or null at the start. */
export function backwardMove(
  page: LoadedPage,
  limit: number,
): { readonly cursor: LogCursor; readonly index: number } | null {
  return page.prevCursor === null
    ? null
    : {
        cursor: { after: null, before: page.prevCursor, tail: false },
        index: Math.max(page.index - limit, 0),
      };
}

/** The empty-state sentence that matches what the reader is looking at. */
function emptyTextFor(
  page: LoadedPage | null,
  query: LogQuery,
  translate: (key: string) => string,
): string {
  if (page !== null && page.total > 0) return translate('logs.emptyPage');
  return hasFilters(query)
    ? translate('logs.emptyFiltered')
    : translate('logs.empty');
}

/** Everything one page read needs from the hook, passed explicitly. */
interface FetchInput {
  readonly generation: { current: number };
  readonly passed: { current: number };
  readonly openedWith: { current: LogCursor };
  readonly keepAnchor: LogAnchor | null;
  readonly next: LogQuery;
  readonly where: LogCursor;
  readonly options: LoadOptions;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (error: string | null) => void;
  readonly setLoaded: (page: LoadedPage) => void;
  readonly setAnchor: (anchor: LogAnchor | null) => void;
  readonly setQuery: (query: LogQuery) => void;
  readonly setDraft: (query: LogQuery) => void;
  readonly setNotice: (notice: { readonly count: number } | null) => void;
  readonly unavailable: string;
  readonly failed: string;
  /** Push a staged page; `moved` is false when the read did not change pages. */
  readonly remember: (moved: boolean) => void;
  /** Drop a staged entry whose navigation failed. */
  readonly discard: () => void;
  /** Invalidate remembered pages when a correction replaces the traversal. */
  readonly forget: () => void;
}

/**
 * Whether an empty page is a lost window rather than an empty set.
 *
 * Only the first answer for a window may trigger the correction: a second empty
 * result is reported as empty, so storage that keeps shrinking cannot spin.
 */
function needsCorrection(
  response: { readonly rows: readonly unknown[]; readonly total: number },
  options: LoadOptions,
): boolean {
  return (
    response.rows.length === 0 &&
    response.total > 0 &&
    options.corrected !== true
  );
}

/**
 * Read one page and commit it, unless a newer read has superseded it.
 *
 * The generation is bumped before the request and re-checked after every await,
 * so a slow answer for an older filter or cursor cannot replace the state of a
 * newer one — including its error.
 */
async function fetchPage(input: FetchInput): Promise<void> {
  input.generation.current += 1;
  const current = input.generation.current;
  input.setBusy(true);
  input.setError(null);
  const params = paramsOf(input.next, input.where);
  if (input.keepAnchor !== null) {
    params.set('anchorTs', String(input.keepAnchor.ts));
    params.set('anchorCallId', input.keepAnchor.callId);
  }
  try {
    const response = await getJson(`/logs?${params.toString()}`, logsResponse);
    if (input.generation.current !== current) return;
    // A failed read is not an empty history. A 503 for an unavailable store
    // arrives as a rejected promise instead, so both paths must name the same
    // condition rather than showing the ordinary empty-state sentence.
    if (!response.ok || response.code === 'audit-unavailable') {
      // The navigation these pages staged did not happen: discarding keeps a
      // later, unrelated success from committing an abandoned move.
      input.discard();
      input.setError(input.unavailable);
      return;
    }
    if (needsCorrection(response, input.options)) {
      // The reader's page lost its rows. The last page is the only position that
      // still exists after a deletion from the tail, and it is reached by name
      // rather than by a count the deletion invalidated. The position is not
      // reset eagerly: the corrective read sets it when it commits, so a failed
      // correction leaves the reader's label intact.
      await fetchPage({
        ...input,
        where: LAST_PAGE,
        options: {
          keepAnchor: response.anchor,
          index: 0,
          corrected: true,
          refresh: input.options.refresh === true,
        },
      });
      return;
    }
    // A tail read lands on the last page, so its position is the rows before it
    // rather than a count the reader already passed: the page it replaced may
    // have been anywhere in the set.
    const index = input.where.tail
      ? Math.max(response.total - response.rows.length, 0)
      : input.options.index;
    input.passed.current = index;
    input.openedWith.current = input.where;
    input.setLoaded({
      rows: response.rows,
      total: response.total,
      nextCursor: response.nextCursor,
      prevCursor: response.prevCursor,
      remaining: response.remaining,
      index,
    });
    input.setAnchor(response.anchor);
    input.setQuery(input.next);
    input.setDraft(input.next);
    input.setNotice(
      input.options.refresh === true && response.newer > 0
        ? { count: response.newer }
        : null,
    );
    // Only now is the move complete, so the page the reader left can join the
    // history. A refresh did not move them, and a correction is an involuntary
    // jump whose superseded pages cannot be restored.
    if (input.options.corrected === true) input.forget();
    else input.remember(input.where.before === null && !input.where.tail);
  } catch (errorValue) {
    if (input.generation.current !== current) return;
    input.discard();
    input.setError(
      isUnavailable(errorValue)
        ? input.unavailable
        : `${input.failed} ${errorText(errorValue)}`,
    );
  } finally {
    if (input.generation.current === current) input.setBusy(false);
  }
}

/** The mutable history state one traversal keeps. */
interface HistoryRefs {
  readonly history: { current: VisitedPage[] };
  readonly staged: { current: VisitedPage | null };
  readonly committed: { current: LoadedPage | null };
  readonly openedWith: { current: LogCursor };
  readonly anchor: LogAnchor | null;
  readonly passed: { current: number };
  readonly publish: (page: LoadedPage, head: LogAnchor | null) => void;
}

/**
 * The visited-page stack: stage on a move, commit on success, restore on back.
 *
 * Separated from the hook so each transition is one function with one job, and so
 * the ordering rule is visible in one place: a page joins the history only after
 * the move that left it has committed.
 */
function historyOf(refs: HistoryRefs): {
  readonly stage: () => void;
  readonly remember: (moved: boolean) => void;
  readonly discard: () => void;
  readonly restore: () => void;
  readonly forget: () => void;
} {
  return {
    stage: () => {
      const page = refs.committed.current;
      if (page === null) return;
      refs.staged.current = {
        page,
        cursor: refs.openedWith.current,
        anchor: refs.anchor,
      };
    },
    remember: (moved) => {
      const entry = refs.staged.current;
      // Always consumed: whether or not this request may commit it, a later
      // request must not inherit it.
      refs.staged.current = null;
      if (entry === null || !moved) return;
      refs.history.current = [
        ...refs.history.current.slice(-(HISTORY_LIMIT - 1)),
        entry,
      ];
    },
    discard: () => {
      refs.staged.current = null;
    },
    restore: () => {
      const visited = refs.history.current.at(-1);
      if (visited === undefined) return;
      // The entry is consumed as it is used, so repeated presses walk further
      // back instead of re-showing the same page.
      refs.history.current = refs.history.current.slice(0, -1);
      refs.passed.current = visited.page.index;
      refs.openedWith.current = visited.cursor;
      refs.committed.current = visited.page;
      refs.publish(visited.page, visited.anchor);
    },
    forget: () => {
      refs.history.current = [];
      refs.staged.current = null;
    },
  };
}

/** One page of the call list, with the interactions the panel offers. */
export function useLogPages(): LogPages {
  const t = useArbiterTranslation();
  const [query, setQuery] = useState<LogQuery>(initialQuery);
  const [draft, setDraft] = useState<LogQuery>(initialQuery);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  /** Publish a page and mirror it for callbacks that need the latest value. */
  const commit = useCallback((page: LoadedPage): void => {
    committed.current = page;
    setLoaded(page);
  }, []);
  const [anchor, setAnchor] = useState<LogAnchor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ readonly count: number } | null>(null);
  /** Monotonic guard: only the newest request may commit its result. */
  const generation = useRef(0);
  /** Rows the reader has passed before the current page. */
  const passed = useRef(0);
  /** The cursor the committed page was read with, so a refresh re-reads it. */
  const openedWith = useRef<LogCursor>(FIRST_PAGE);
  /** The page currently on screen; a ref so `remember` needs no page argument. */
  const committed = useRef<LoadedPage | null>(null);
  /**
   * Pages the reader has already seen, newest last.
   *
   * "Previous" restores this instead of re-querying. A backward query would
   * select whatever rows now precede the cursor, so a call inserted above the
   * reader would displace a row they had already read — the page would silently
   * change under them. Restoring keeps the boundary they actually observed.
   */
  const history = useRef<VisitedPage[]>([]);
  /** The page and cursor the reader is leaving, staged until the move commits. */
  const staged = useRef<VisitedPage | null>(null);

  const { stage, remember, discard, restore, forget } = historyOf({
    history,
    staged,
    committed,
    openedWith,
    anchor,
    passed,
    publish: (page, head) => {
      setLoaded(page);
      setAnchor(head);
      setNotice(null);
      setError(null);
    },
  });

  const read = useCallback(
    (next: LogQuery, where: LogCursor, options: LoadOptions): Promise<void> =>
      fetchPage({
        generation,
        passed,
        openedWith,
        keepAnchor: options.keepAnchor,
        next,
        where,
        options,
        setBusy,
        setError,
        setLoaded: commit,
        setAnchor,
        setQuery,
        setDraft,
        setNotice,
        unavailable: t('logs.auditUnavailable'),
        failed: t('logs.loadFailed'),
        remember,
        discard,
        forget,
      }),
    [t, commit],
  );

  /** Run one read, covering only the promise the handler did not await. */
  const run = useCallback(
    (next: LogQuery, where: LogCursor, options: LoadOptions): void => {
      read(next, where, options).catch((failure: unknown) => {
        setError(`${t('logs.loadFailed')} ${errorText(failure)}`);
      });
    },
    [read, t],
  );

  useEffect(() => {
    // The initial read runs once; every later read is an explicit interaction,
    // which is what keeps a new record from moving the reader's page.
    run(initialQuery(), FIRST_PAGE, { keepAnchor: null, index: 0 });
  }, [run]);

  const startOver = useCallback(
    (next: LogQuery): void => {
      // The position is not reset here: the commit for a successful first-page
      // read sets it to zero. Resetting eagerly would relabel the page the reader
      // is still on as page one if this request fails, and a later refresh would
      // then commit that wrong position.
      run(next, FIRST_PAGE, { keepAnchor: null, index: 0 });
    },
    [run],
  );

  return composePages({
    t,
    query,
    draft,
    page: loaded,
    anchor,
    error,
    notice,
    busy,
    index: passed.current,
    openedWith: openedWith.current,
    visited: history.current,
    setDraft,
    startOver,
    run,
    stage,
    remember,
    discard,
    restore,
    forget,
  });
}

/** How many already-seen pages stay reachable in one traversal. */
const HISTORY_LIMIT = 50;

/** Everything the panel needs, assembled from the hook's state and callbacks. */
function composePages(input: {
  readonly t: (key: string) => string;
  readonly query: LogQuery;
  readonly draft: LogQuery;
  readonly page: LoadedPage | null;
  readonly anchor: LogAnchor | null;
  readonly error: string | null;
  readonly notice: { readonly count: number } | null;
  readonly busy: boolean;
  readonly index: number;
  readonly openedWith: LogCursor;
  readonly visited: readonly VisitedPage[];
  readonly setDraft: (draft: LogQuery) => void;
  readonly startOver: (next: LogQuery) => void;
  readonly run: (
    next: LogQuery,
    where: LogCursor,
    options: LoadOptions,
  ) => void;
  readonly stage: () => void;
  readonly remember: (moved: boolean) => void;
  readonly discard: () => void;
  readonly restore: () => void;
  readonly forget: () => void;
}): LogPages {
  const { page, query, anchor, t } = input;
  const previousPage = input.visited.at(-1);
  return {
    query,
    draft: input.draft,
    loaded: page,
    error: input.error,
    notice: input.notice,
    busy: input.busy,
    index: input.index,
    emptyText: emptyTextFor(page, query, t),
    hasNext: page !== null && page.remaining > 0,
    hasPrevious:
      page !== null && (previousPage !== undefined || page.index > 0),
    setDraft: input.setDraft,
    applyFilters: () => {
      // The confirmed filters replace the current query, and the cursor is
      // dropped because a position in the old result set says nothing about the
      // new one; the remembered pages belong to that old set.
      input.forget();
      input.startOver(input.draft);
    },
    clearFilters: () => {
      input.forget();
      input.startOver(initialQuery());
    },
    backToLatest: () => {
      input.forget();
      input.startOver(query);
    },
    refresh: () => {
      input.run(query, input.openedWith, {
        keepAnchor: anchor,
        index: input.index,
        refresh: true,
      });
    },
    next: () => {
      if (page === null || page.remaining <= 0) return;
      const move = forwardMove(page);
      if (move === null) return;
      // The page being left is staged now and remembered only if the move
      // commits, so a failed read never records a page the reader stayed on.
      input.stage();
      input.run(query, move.cursor, { keepAnchor: anchor, index: move.index });
    },
    previous: () => {
      if (page === null) return;
      // A page the reader has already seen is restored, not re-queried: a
      // backward query would return whatever now precedes the cursor, and a call
      // inserted above them would push a row they already read off the page.
      if (previousPage !== undefined) {
        input.restore();
        return;
      }
      const move = backwardMove(page, query.limit);
      if (move === null) return;
      input.run(query, move.cursor, { keepAnchor: anchor, index: move.index });
    },
  };
}

/** Whether a rejected request reports the audit store as unavailable. */
function isUnavailable(errorValue: unknown): boolean {
  return (
    errorValue instanceof Error &&
    'code' in errorValue &&
    errorValue.code === 'audit-unavailable'
  );
}
