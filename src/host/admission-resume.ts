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
import type { AdmissionFailure } from './admission-veto.js';
import { narrowWrites } from './boundary-writes.js';
import type { AdmissionScope, ExecutionBoundary } from '../types.js';
import type { SessionLike } from '../snapshot.js';
import type { AdmissionAdapters } from './admission-adapters.js';
import type { HostEnvironment } from './types.js';

/**
 * Answer a call from a session that restored after coverage was refused.
 *
 * Such a session never took part in the refusal's cleanup, so a sandbox an
 * earlier trusted run left it with is taken back here. If that cannot be
 * confirmed the call is refused: a fail-closed marker for later calls cannot
 * protect the call already in flight.
 */
export function refuseLateRestore(
  host: HostEnvironment,
  targets: ResumeTargets,
  id: string,
  session: SessionLike,
  recorded: ExecutionBoundary | undefined,
): AdmissionScope {
  // Only a sandbox this plugin granted is taken back; `read-only` stays.
  if (recorded === 'trusted') {
    targets.writeSessionKnobs(session, narrowWrites(session));
  }
  targets.dropCoverage(id);
  if (!targets.atSafeSandbox(session)) {
    targets.markFailingClosed(id);
    host.ctx.logger.error(
      'arbiter: session %s could not be narrowed after a refused resume',
      id,
    );
    return {
      managed: false,
      reason: 'boundary-unconfirmed',
      admission: null,
      unresolvedParent: null,
    };
  }
  return {
    managed: false,
    reason: 'coverage-refused',
    admission: null,
    unresolvedParent: null,
  };
}

/** What a resume refusal needs: the admission service's write primitives. */
export type ResumeTargets = AdmissionAdapters;

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
