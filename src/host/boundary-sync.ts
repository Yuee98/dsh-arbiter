/**
 * Re-applying the effective boundary after a configuration activation.
 *
 * A save is not a takeover on its own, but it can be where one starts: a
 * retained admission that was not gated (master switch off) becomes active
 * again. That off → on transition consults the same veto a first enable does,
 * and a refusal is remembered rather than re-derived, because sessions restore
 * lazily and an unrelated save must not quietly revoke it.
 *
 * Both the held widening and the refused resume are released only on positive
 * evidence that the provider stopped. `unknown` — an unreadable Loader, a
 * missing event bus — is missing evidence, and the contract forbids reading it
 * as resolution.
 */

import { activationOf } from './activation.js';
import { refuseResume } from './admission-resume.js';
import { narrowWrites } from './boundary-writes.js';
import { configuredBoundary } from './admission.js';
import type { AdmissionAdapters } from './admission-adapters.js';
import type { AdmissionFailure } from './admission-veto.js';
import type { ArbiterConfig, ExecutionBoundary } from '../types.js';
import type { SessionLike } from '../snapshot.js';
import type { HostEnvironment } from './types.js';

/** What the sync needs from the admission service. */
export interface BoundarySync extends AdmissionAdapters {
  readonly covered: ReadonlyMap<string, SessionLike>;
  readonly active: boolean;
  readonly refusalStands: boolean;
  setActive(active: boolean): void;
  hold(id: string): void;
  release(id: string): void;
  isHeld(id: string): boolean;
  refuse(): void;
  clearRefusal(): void;
  /** Whether an existing restriction may be released at all. */
  releasable(): boolean;
  /** Whether the veto currently refuses a new activation. */
  vetoPresent(): boolean;
  /** Whether the host can distinguish `unknown` from `stopped` at all. */
  triState(): boolean;
  /** Whether coverage must not begin because the state is unprovable. */
  unprovable(): boolean;
  veto(): Omit<AdmissionFailure, 'ok'> | null;
  retained(
    id: string,
  ): { readonly enabled: boolean; readonly boundary: ExecutionBoundary } | null;
  releaseManagedScope(): void;
}

/** Re-apply the configured boundary to the sessions still enabled. */
export function applyBoundary(
  host: HostEnvironment,
  sync: BoundarySync,
  config: ArbiterConfig,
): void {
  if (!config.enabled) {
    // The switch turning off stops the gate, so a widened session would run
    // ungated while keeping the permission. Narrow first, as teardown does.
    sync.setActive(false);
    sync.clearRefusal();
    sync.releaseManagedScope();
    return;
  }
  if (!sync.active) {
    sync.setActive(true);
    const veto = sync.veto();
    // An unprovable state blocks a start for the same reason a running provider
    // does: the contract forbids a takeover it cannot show to be safe.
    if (veto !== null || (sync.triState() && sync.unprovable())) {
      sync.refuse();
      refuseResume(
        host,
        sync,
        veto ?? {
          code: 'coexistence-blocked',
          message:
            'another approval provider may be running and could not be ruled out',
        },
      );
      return;
    }
  }
  // A refusal outlives an unrelated save and an unreadable surface alike.
  if (sync.refusalStands && sync.releasable()) sync.clearRefusal();
  for (const [id, session] of sync.covered) {
    syncOne(host, sync, id, session, configuredBoundary(config));
  }
}

/** Bring one covered session to the configured boundary, or leave it held. */
function syncOne(
  host: HostEnvironment,
  sync: BoundarySync,
  id: string,
  session: SessionLike,
  boundary: ExecutionBoundary,
): void {
  const folded = sync.retained(id);
  if (folded === null) {
    // An inherited scope has no record of its own: when its root narrows, the
    // sandbox the host captured at delegation must narrow with it.
    if (boundary !== 'trusted')
      sync.writeSessionKnobs(session, narrowWrites(session));
    return;
  }
  if (!folded.enabled || folded.boundary === boundary) return;
  // An established withholding is only released by positive evidence.
  if (sync.isHeld(id) && !sync.releasable()) return;
  // The same predicate the lazy path and `enable()` use: a new widening waits
  // when the provider state is unreadable after a confirmed conflict, not only
  // when the veto currently returns a refusal.
  const activation = activationOf(
    session,
    boundary,
    folded.boundary,
    sync.vetoPresent() || sync.unprovable(),
    true,
  );
  if (activation.writes.length === 0) return;
  if (activation.withheld) sync.hold(id);
  else sync.release(id);
  sync.writeSessionKnobs(session, activation.writes);
  const state = sync.writeAdmission(session, true, activation.boundary);
  if (state !== 'written') {
    host.ctx.logger.warn(
      'arbiter: boundary sync for session %s failed: %s',
      id,
      state,
    );
    return;
  }
  host.ctx.logger.info(
    'arbiter: session %s moved to boundary %s',
    id,
    activation.boundary,
  );
}
