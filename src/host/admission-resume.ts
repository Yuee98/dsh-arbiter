/**
 * Refusing to start or resume coverage under a running conflict.
 *
 * Starting coverage is a takeover even when the admission records were retained
 * from an earlier run: while the master switch was off this plugin did not gate
 * those sessions, so turning it back on begins a new arbitration. If another
 * approval provider is active at that moment, the mutual-exclusion contract says
 * it must not begin — and, because a previous trusted run may have left a wide
 * sandbox behind, any permission this plugin widened has to be taken back in the
 * same step.
 *
 * This module owns only that decision and its two writes; the admission service
 * still owns `covered`, the fold and every other transition.
 */

import { boundaryWrites, narrowWrites } from './boundary-writes.js';
import type { RecordState } from '../records.js';
import type { AdmissionFailure } from './admission-veto.js';
import type { ExecutionBoundary } from '../types.js';
import type { SessionLike } from '../snapshot.js';
import type { HostEnvironment, KnobWrite } from './types.js';

/** What the admission service must expose for a resume refusal to be applied. */
export interface ResumeTargets {
  /** Sessions a resume would cover, with their own records, already discovered. */
  resumeTargets(): readonly (readonly [string, SessionLike])[];
  /** Write one admission record and report whether it committed. */
  writeAdmission(
    session: SessionLike,
    enabled: boolean,
    boundary: ExecutionBoundary,
  ): RecordState;
  /** Write knob events for one session. */
  writeSessionKnobs(session: SessionLike, writes: readonly KnobWrite[]): void;
  /** Whether the session is back at a value this plugin can call safe. */
  atSafeBoundary(session: SessionLike): boolean;
  /** Mark a session whose rollback could not be confirmed. */
  markFailingClosed(sessionId: string): void;
  /** Drop a session from coverage. */
  dropCoverage(sessionId: string): void;
}

/**
 * Refuse a resume: narrow what this plugin widened, then close the records.
 *
 * Order matters for the same reason teardown has one: withdrawing gate
 * protection first would leave a wide session ungated. The record is written
 * last and says `disabled`, so a cold reader cannot believe coverage resumed.
 */
export function refuseResume(
  host: HostEnvironment,
  targets: ResumeTargets,
  veto: Omit<AdmissionFailure, 'ok'>,
): void {
  for (const [id, session] of targets.resumeTargets()) {
    const delegated = session.header?.parentSession !== undefined;
    targets.writeSessionKnobs(
      session,
      delegated ? narrowWrites(session) : boundaryWrites(session, 'guarded'),
    );
    if (!targets.atSafeBoundary(session)) {
      targets.markFailingClosed(id);
      host.ctx.logger.error(
        'arbiter: session %s could not be narrowed while another approval provider runs',
        id,
      );
    }
    const state = targets.writeAdmission(session, false, 'guarded');
    targets.dropCoverage(id);
    host.ctx.logger.warn(
      'arbiter: coverage for session %s was not resumed (%s, record %s)',
      id,
      veto.code,
      state,
    );
  }
  host.lifecycle('admission/resume-refused', { code: veto.code });
}
