/**
 * The backend-confirmed view for one session.
 *
 * Clients read the effective answer from here instead of deriving it from a
 * preset name. A refused resume is part of that answer: coverage is
 * deliberately not in force there, so the view must not claim it is.
 */

import { admissionRevision, resolveScope } from './admission.js';
import type { FoldedAdmission, ScopeLookup } from './admission.js';
import type { ExecutionBoundary, SessionAdmissionView } from '../types.js';

/** What producing one view needs from the admission service. */
export interface ViewSource {
  readonly known: (id: string) => boolean;
  readonly lookup: () => ScopeLookup;
  readonly admissionOf: (id: string) => FoldedAdmission | null;
  readonly rootOf: (id: string) => string;
  readonly boundary: () => ExecutionBoundary;
  /** Whether a refused resume currently stands and has not been released. */
  readonly refused: () => boolean;
}

/**
 * Build the view for one session under one configuration revision.
 *
 * @returns `null` for a session this runtime does not know.
 */
export function sessionView(
  source: ViewSource,
  id: string,
  revision: string,
): SessionAdmissionView | null {
  if (!source.known(id)) return null;
  const scope = resolveScope(id, source.lookup());
  const folded = source.admissionOf(id);
  return {
    sessionId: id,
    rootSessionId: source.rootOf(id),
    enabled: folded?.enabled ?? false,
    boundary: folded?.boundary ?? source.boundary(),
    revision,
    // The identity of the persisted admission, distinct from the effective
    // configuration revision; `null` only when there is no record at all.
    admissionRevision: folded === null ? null : admissionRevision(id, folded),
    seq: folded?.seq ?? null,
    at: folded?.at ?? null,
    // A refused resume means coverage is deliberately not in force, however the
    // retained record reads: reporting `session-enabled` there would claim a
    // takeover the conflict forbade.
    reason: source.refused() ? 'coverage-refused' : scope.reason,
    managed: scope.managed && !source.refused(),
  };
}
