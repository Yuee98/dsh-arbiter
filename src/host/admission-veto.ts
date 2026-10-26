/**
 * The pre-admission veto a policy module can install.
 *
 * Kept apart from the admission service so the service's own file stays about
 * folding, boundaries and writes: a veto decides *whether* a takeover may start,
 * and the service still decides *how* every side effect is ordered.
 */

import type { HostEnvironment } from './types.js';

export interface AdmissionFailure {
  readonly ok: false;
  readonly code:
    | 'session-unknown'
    | 'record-unavailable'
    | 'record-failed'
    | 'plugin-disabled'
    | 'stopping'
    | 'boundary-not-applied'
    | 'boundary-unconfirmed'
    | 'invalid-action'
    | 'coexistence-blocked';
  readonly message: string;
  /** Structured context a client can render, e.g. a coexistence block. */
  readonly detail?: Readonly<Record<string, unknown>>;
}

/**
 * Returns the refusal to use, or `null` to let the takeover proceed.
 */
export type EnableGuard = () => Omit<AdmissionFailure, 'ok'> | null;

/**
 * The veto used when another provider may be running but could not be read.
 *
 * Treated exactly like a confirmed conflict for a *new* takeover: the contract
 * forbids beginning coverage it cannot show to be safe, and an unreadable
 * surface is missing evidence rather than proof of resolution.
 */
export function unprovableVeto(): Omit<AdmissionFailure, 'ok'> {
  return {
    code: 'coexistence-blocked',
    message:
      'another approval provider may be running and could not be ruled out',
  };
}

/** Refuse a takeover: the lifecycle records it and nothing was written. */
export function refuseEnable(
  host: HostEnvironment,
  sessionId: string,
  veto: Omit<AdmissionFailure, 'ok'>,
): AdmissionFailure {
  host.lifecycle('admission/blocked', { sessionId, code: veto.code });
  return { ok: false, ...veto };
}
