/**
 * Confirmed-state bookkeeping for the permission selector.
 *
 * The shown value is always the last answer the backend confirmed. Nothing
 * here is optimistic: a pending write marks the control busy, it never moves
 * the displayed value. A failure keeps the last confirmed view, so a refused
 * switch cannot look like a successful one. The module is free of React and
 * fetch, which is what makes it worth testing exhaustively.
 */

import type {
  SessionAdmissionResponse,
  SessionAdmissionView,
} from './view-types.js';

/** Stable failure codes the component localizes; `detail` is the fallback. */
const FAILURE_CODES = [
  'session-required',
  'session-unknown',
  'invalid-action',
  'boundary-not-overridable',
  'boundary-unconfirmed',
  'boundary-not-applied',
  'record-unavailable',
  'record-failed',
  'plugin-disabled',
  'stopping',
  'request-failed',
  'host-unavailable',
  'command-not-applied',
] as const;

export type AdmissionFailureCode = (typeof FAILURE_CODES)[number];

export interface AdmissionFailure {
  readonly code: AdmissionFailureCode;
  /** The host's own words, shown only where the localized copy names it. */
  readonly detail: string;
}

/** What the control knows right now. */
export interface AdmissionState {
  /** The last backend-confirmed view; `null` until one answer arrives. */
  readonly confirmed: SessionAdmissionView | null;
  /** A request is in flight; the control refuses new interaction. */
  readonly pending: boolean;
  /** The last refusal this control saw. */
  readonly failure: AdmissionFailure | null;
  /**
   * A write is in flight.
   *
   * Reads requested now are coalesced into one read after the write settles,
   * because a later *issued* read is not necessarily a newer *server* state: a
   * focus read can overtake an unfinished POST and then its answer would be
   * older than the write's. Only the write's own answer can settle that race.
   */
  readonly writing: boolean;
  /** A read was requested while a write was in flight; run it afterwards. */
  readonly readQueued: boolean;
}

export const EMPTY_ADMISSION_STATE: AdmissionState = {
  confirmed: null,
  pending: false,
  failure: null,
  writing: false,
  readQueued: false,
};

/** Runtime narrowing for a code that crossed the wire as a plain string. */
export function isFailureCode(value: string): value is AdmissionFailureCode {
  return (FAILURE_CODES as readonly string[]).includes(value);
}

function codeOf(error: unknown): string {
  if (error === null || typeof error !== 'object') return '';
  const code: unknown = Reflect.get(error, 'code');
  return typeof code === 'string' ? code : '';
}

/** Map any thrown value to a stable code so the UI never shows raw text alone. */
export function failureOf(error: unknown): AdmissionFailure {
  const detail = error instanceof Error ? error.message : String(error);
  const code = codeOf(error);
  return { code: isFailureCode(code) ? code : 'request-failed', detail };
}

/** A refusal answer becomes the same shape as a thrown transport error. */
export function failureFromAnswer(
  answer: Extract<SessionAdmissionResponse, { ok: false }>,
): AdmissionFailure {
  return {
    code: isFailureCode(answer.code) ? answer.code : 'request-failed',
    detail: answer.message,
  };
}

/** A read started: busy, and the previous refusal no longer applies. */
export function started(state: AdmissionState): AdmissionState {
  return { ...state, pending: true, failure: null };
}

/** A write started. A read must not settle the state before this write does. */
export function writing(state: AdmissionState): AdmissionState {
  return { ...state, pending: true, failure: null, writing: true };
}

/** A read arrived while the write was in flight: remember it, do not start it. */
export function queueRead(state: AdmissionState): AdmissionState {
  return state.writing ? { ...state, readQueued: true } : state;
}

/** A confirmed answer replaces the view and clears both busy flags. */
export function confirmed(
  _state: AdmissionState,
  view: SessionAdmissionView,
): AdmissionState {
  return {
    confirmed: view,
    pending: false,
    failure: null,
    writing: false,
    readQueued: false,
  };
}

/**
 * A confirmed answer that arrives while a mutation is still reconciling.
 *
 * The value is authoritative and is shown, but the control stays busy and
 * noninteractive: the mutation has not finished deciding whether the switch
 * applied, and letting a second selection start here would produce two
 * overlapping mutations whose ordering nothing guarantees.
 */
export function confirmedWhileWriting(
  state: AdmissionState,
  view: SessionAdmissionView,
): AdmissionState {
  return {
    ...state,
    confirmed: view,
    pending: true,
    failure: null,
    writing: true,
  };
}

/** A mutation finished: only now may the control become interactive again. */
export function settled(state: AdmissionState): AdmissionState {
  return { ...state, pending: false, writing: false, readQueued: false };
}

/** A failure keeps the last confirmed view: the requested value never lands. */
export function failed(
  state: AdmissionState,
  failure: AdmissionFailure,
): AdmissionState {
  return {
    ...state,
    pending: false,
    failure,
    writing: false,
    readQueued: false,
  };
}

/**
 * Whether the last answer makes this session addressable.
 *
 * `session-unknown` means the host has not materialized the session yet. The
 * previous confirmation is kept internally, but it must not stay actionable:
 * a switch would be refused, and showing the old enabled state as if it were
 * current would misrepresent the session.
 */
export function isUnavailable(state: AdmissionState): boolean {
  return state.failure?.code === 'session-unknown';
}

/** Whether the control may be operated at all right now. */
export function isInteractive(
  state: AdmissionState,
  options: { readonly locked: boolean; readonly sessionId: string | null },
): boolean {
  return (
    !options.locked &&
    options.sessionId !== null &&
    state.confirmed !== null &&
    !state.pending &&
    !isUnavailable(state)
  );
}
