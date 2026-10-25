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
 *   the window already read.
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

/** Whether another page exists after this one; `total` is the whole set. */
function pageHasNext(page: LoadedPage): boolean {
  return page.nextCursor !== null && page.index + page.rows.length < page.total;
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
      input.setError(input.unavailable);
      return;
    }
    if (response.rows.length === 0 && response.total > 0) {
      if (input.options.corrected !== true) {
        // The reader's page lost its rows. The last page is the only position
        // that still exists after a deletion from the tail, and it is reached by
        // name rather than by a count that the deletion invalidated.
        input.passed.current = 0;
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
  } catch (errorValue) {
    if (input.generation.current !== current) return;
    input.setError(
      isUnavailable(errorValue)
        ? input.unavailable
        : `${input.failed} ${errorText(errorValue)}`,
    );
  } finally {
    if (input.generation.current === current) input.setBusy(false);
  }
}

/** One page of the call list, with the interactions the panel offers. */
export function useLogPages(): LogPages {
  const t = useArbiterTranslation();
  const [query, setQuery] = useState<LogQuery>(initialQuery);
  const [draft, setDraft] = useState<LogQuery>(initialQuery);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
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
        setLoaded,
        setAnchor,
        setQuery,
        setDraft,
        setNotice,
        unavailable: t('logs.auditUnavailable'),
        failed: t('logs.loadFailed'),
      }),
    [t],
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
      passed.current = 0;
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
    setDraft,
    startOver,
    run,
  });
}

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
  readonly setDraft: (draft: LogQuery) => void;
  readonly startOver: (next: LogQuery) => void;
  readonly run: (
    next: LogQuery,
    where: LogCursor,
    options: LoadOptions,
  ) => void;
}): LogPages {
  const { page, query, anchor, t } = input;
  return {
    query,
    draft: input.draft,
    loaded: page,
    error: input.error,
    notice: input.notice,
    busy: input.busy,
    index: input.index,
    emptyText: emptyTextFor(page, query, t),
    hasNext: page !== null && pageHasNext(page),
    hasPrevious: page !== null && page.index > 0,
    setDraft: input.setDraft,
    applyFilters: () => {
      // The confirmed filters replace the current query, and the cursor is
      // dropped because a position in the old result set says nothing about the
      // new one.
      input.startOver(input.draft);
    },
    clearFilters: () => {
      input.startOver(initialQuery());
    },
    backToLatest: () => {
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
      if (page === null) return;
      const move = forwardMove(page);
      if (move === null) return;
      input.run(query, move.cursor, { keepAnchor: anchor, index: move.index });
    },
    previous: () => {
      if (page === null) return;
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
