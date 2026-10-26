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

import { restrictedWrites } from './admission-narrow.js';
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
  /** Whether the session's sandbox is at a value this plugin calls safe. */
  atSafeSandbox(session: SessionLike): boolean;
  /** Mark a session whose rollback could not be confirmed. */
  markFailingClosed(sessionId: string): void;
  /** Drop a session from coverage. */
  dropCoverage(sessionId: string): void;
}

/**
 * Refuse a resume: take back what this plugin widened, then close the records.
 *
 * The cleanup is monotonic in the restrictive direction. It never applies the
 * `guarded` boundary unconditionally: a session the host confined more strictly
 * (read-only, an approval policy tighter than ask) must not be widened by a
 * refusal that only meant "do not take over". So the approval policy is left
 * alone entirely, and the sandbox only moves when it is the value this plugin
 * itself grants.
 *
 * Order matters for the same reason teardown has one: withdrawing gate
 * protection first would leave a wide session ungated. The record is written
 * last, and a record that does not commit leaves the session fail-closed rather
 * than silently covered.
 */
export function refuseResume(
  host: HostEnvironment,
  targets: ResumeTargets,
  veto: Omit<AdmissionFailure, 'ok'>,
): void {
  for (const [id, session] of targets.resumeTargets()) {
    // Restrictive only: this removes a sandbox this plugin granted and leaves a
    // stricter host choice — read-only, or an approval policy tighter than ask —
    // exactly as the user left it.
    targets.writeSessionKnobs(session, restrictedWrites(session));
    if (!targets.atSafeSandbox(session)) {
      targets.markFailingClosed(id);
      host.ctx.logger.error(
        'arbiter: session %s could not be narrowed while another approval provider runs',
        id,
      );
    }
    const state = targets.writeAdmission(session, false, 'guarded');
    if (state !== 'written') {
      // The old enabled record is still authoritative, so coverage must not be
      // treated as retired: keep it fail-closed and let a later read retry.
      targets.markFailingClosed(id);
      host.ctx.logger.error(
        'arbiter: coverage for session %s could not be marked refused (%s)',
        id,
        state,
      );
      continue;
    }
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
