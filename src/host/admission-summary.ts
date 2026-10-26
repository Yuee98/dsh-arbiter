/**
 * One bounded, read-only summary of session admission for the state payload.
 *
 * The payload answers "what does this runtime cover right now", not "what did
 * the user configure": session state lives in the session log, and this is only a
 * projection of the ids this runtime currently holds.
 */

import { configuredBoundary } from './admission.js';
import type { HostEnvironment } from './types.js';

/** The slice of the admission service the summary reads. */
export interface AdmissionCoverage {
  readonly coveredIds: readonly string[];
  readonly failingClosed: readonly string[];
  admission(id: string): { readonly enabled: boolean } | null;
}

/**
 * The summary the state payload carries.
 *
 * `sessions` is bounded so a busy runtime cannot grow the response without
 * limit; the full per-session state stays readable through the admission API.
 */
export function admissionSummary(
  host: HostEnvironment,
  coverage: AdmissionCoverage,
): unknown {
  return {
    boundary: configuredBoundary(host.runtime.config),
    covered: coverage.coveredIds.length,
    failingClosed: [...coverage.failingClosed],
    sessions: coverage.coveredIds.slice(-20).map((id) => {
      const admission = coverage.admission(id);
      return admission === null
        ? { sessionId: id, admission: null }
        : { sessionId: id, admission };
    }),
  };
}
