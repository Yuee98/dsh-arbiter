/**
 * The narrow surface the admission helpers need from the admission service.
 *
 * Lifecycle rules live in small modules so each can be read on its own: resume
 * refusal, late-restore refusal, monotonic narrowing. They share one requirement
 * — the admission service's own write primitives — so that requirement is
 * declared once instead of once per helper.
 */

import type { ExecutionBoundary } from '../types.js';
import type { RecordState } from '../records.js';
import type { SessionLike } from '../snapshot.js';
import type { KnobWrite } from './types.js';

export interface AdmissionAdapters {
  /** Sessions a resume would have covered, after discovery. */
  resumeTargets(): readonly (readonly [string, SessionLike])[];
  /** Write one admission record and report whether it committed. */
  writeAdmission(
    session: SessionLike,
    enabled: boolean,
    boundary: ExecutionBoundary,
  ): RecordState;
  /** Write knob events for one session. */
  writeSessionKnobs(session: SessionLike, writes: readonly KnobWrite[]): void;
  /** Whether the sandbox is at a value this plugin can call safe. */
  atSafeSandbox(session: SessionLike): boolean;
  /**
   * Mark a session whose rollback could not be confirmed.
   *
   * `byRefusal` records provenance: a refusal only promised a safe sandbox,
   * while a teardown promised the full exit boundary, so recovery must verify
   * the right one.
   */
  markFailingClosed(sessionId: string, byRefusal?: boolean): void;
  /** Drop one session from coverage. */
  dropCoverage(sessionId: string): void;
}
