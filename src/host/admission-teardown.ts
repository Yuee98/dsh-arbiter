/**
 * The subtree work an admission exit needs.
 *
 * A parent's exit only changes the parent's own sandbox. Children captured it at
 * delegation and have no record to fold, so once the parent is disabled they
 * would resolve as `parent-not-admitted` and run ungated with the parent's old
 * privilege. That makes the branch below a session load-bearing in two places:
 * teardown must narrow it, and a disable must not call the subtree safe while
 * any of it is still wide.
 *
 * These are the shared decisions; the admission service keeps the writes, their
 * ordering and the fail-closed bookkeeping.
 */

import { isBelow } from './descendants.js';
import type { SessionLike } from '../snapshot.js';

/** What the subtree rules need from the admission service. */
export interface TeardownView {
  /** Every session this runtime currently covers. */
  readonly covered: ReadonlyMap<string, SessionLike>;
  /** Every session that could descend from one being disabled. */
  branchCandidates(): ReadonlyMap<string, SessionLike>;
  /** Whether one session is already at the value teardown must restore. */
  atSafeBoundary(session: SessionLike): boolean;
  /** Whether `id` sits below `ancestor` in the bounded parent chain. */
  isDescendantOf(id: string, ancestor: string): boolean;
  /** Narrow one session, reporting whether the write was confirmed. */
  narrowSession(session: SessionLike): boolean;
  /** Remember a session whose rollback could not be confirmed. */
  markFailingClosed(id: string): void;
  /** Forget one session's coverage. */
  dropCoverage(id: string): void;
}

/**
 * Narrow every still-managed descendant of a session that just left.
 *
 * @returns how many sessions were narrowed.
 */
export function narrowBranch(view: TeardownView, rootId: string): number {
  let narrowed = 0;
  for (const [id, session] of view.branchCandidates()) {
    if (id === rootId || !view.isDescendantOf(id, rootId)) continue;
    if (view.atSafeBoundary(session)) continue;
    if (view.narrowSession(session)) narrowed += 1;
    else view.markFailingClosed(id);
    view.dropCoverage(id);
  }
  return narrowed;
}

/**
 * Whether a session and everything below it is safe. The subtree only:
 * disabling a child must not demand that its still-admitted parent is already
 * narrowed, because the parent's own exit narrows it.
 */
export function subtreeIsSafe(view: TeardownView, rootId: string): boolean {
  return [...view.covered].every(
    ([id, session]) =>
      id === rootId ||
      !view.isDescendantOf(id, rootId) ||
      view.atSafeBoundary(session),
  );
}

/** The parts of the admission service the subtree rules need, as one view. */
export interface TeardownSource extends Omit<TeardownView, 'branchCandidates'> {
  /** Observe a session so its parent chain is readable. */
  observeForBranch(session: SessionLike): void;
  /** Every session the host currently reports as live. */
  liveSessions(): readonly SessionLike[];
}

/** Build the view a `TeardownSource` exposes to these rules. */
export function teardownViewOf(source: TeardownSource): TeardownView {
  return {
    covered: source.covered,
    // `discover()` is deliberately avoided: it prunes by current scope, and by
    // now the parent folds as disabled, so descendants would be dropped.
    branchCandidates: () => {
      const candidates = new Map<string, SessionLike>(source.covered);
      for (const session of source.liveSessions()) {
        const id = session.id;
        if (id === undefined) continue;
        source.observeForBranch(session);
        candidates.set(id, session);
      }
      return candidates;
    },
    atSafeBoundary: (session) => source.atSafeBoundary(session),
    isDescendantOf: (id, ancestor) => source.isDescendantOf(id, ancestor),
    narrowSession: (session) => source.narrowSession(session),
    markFailingClosed: (id) => {
      source.markFailingClosed(id);
    },
    dropCoverage: (id) => {
      source.dropCoverage(id);
    },
  };
}

/** Whether `id` sits below `ancestor`, using the session lookup for parents. */
export function descendantOf(
  id: string,
  ancestor: string,
  parentOf: (id: string) => string | undefined,
): boolean {
  return isBelow(id, ancestor, parentOf);
}
