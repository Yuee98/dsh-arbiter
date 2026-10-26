/**
 * Stateful session admission: fold, apply and report one session's switch.
 *
 * This module is the backend authority for "is arbiter enabled for this
 * session". Clients read the confirmed view from here instead of deriving it
 * from a preset name. Every write is one ignorable plugin record, so the state
 * survives a cold restart through the session log alone — never through the
 * audit database.
 */

import { appendRecord, sessionRecordReady } from '../records.js';
import type { RecordState } from '../records.js';
import type { SessionLike } from '../snapshot.js';
import type {
  AdmissionScope,
  ArbiterConfig,
  ExecutionBoundary,
  SessionAdmission,
  SessionAdmissionView,
} from '../types.js';
import {
  atSafeSandbox,
  boundaryIsSafe,
  narrowWrites,
} from './boundary-writes.js';
import {
  ADMISSION_RECORD_TYPE,
  ADMISSION_VERSION,
  configuredBoundary,
  foldAdmission,
  parentChain,
  resolveScope,
  toAdmission,
} from './admission.js';
import type { FoldedAdmission } from './admission.js';
import { refuseLateRestore } from './admission-resume.js';
import { activationOf } from './activation.js';
import { sessionView } from './admission-view.js';
import { releaseLateSession } from './admission-release.js';
import { applyBoundary } from './boundary-sync.js';
import type { BoundarySync } from './boundary-sync.js';
import { exitWrites } from './admission-narrow.js';
import {
  descendantOf,
  narrowBranch,
  subtreeIsSafe,
  teardownViewOf,
} from './admission-teardown.js';
import type { TeardownView } from './admission-teardown.js';
import type { AdmissionAdapters } from './admission-adapters.js';
import { narrowWithRetry } from './narrow-retry.js';
import { CoverageHold } from './coverage-hold.js';
import { admissionSummary } from './admission-summary.js';
import { refuseEnable, unprovableVeto } from './admission-veto.js';
import type { ProviderState } from './coexistence.js';
import type { AdmissionFailure, EnableGuard } from './admission-veto.js';
import type { HostEnvironment, KnobWrite } from './types.js';

export type AdmissionTrigger = 'api' | 'permission-command' | 'boundary-sync';

export type { AdmissionFailure, EnableGuard } from './admission-veto.js';

export type AdmissionResult =
  { readonly ok: true; readonly view: SessionAdmissionView } | AdmissionFailure;

interface CacheEntry {
  readonly lastSeq: number;
  readonly folded: FoldedAdmission | null;
}

export class SessionAdmissions {
  private readonly host: HostEnvironment;
  /** Fold cache keyed by session id and guarded by the last committed seq. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Sessions this runtime has read; a parent may already be out of the store. */
  private readonly observed = new Map<string, SessionLike>();
  /** Sessions inside an enabled admission, for boundary sync and teardown. */
  private readonly covered = new Map<string, SessionLike>();
  /** Sessions whose teardown rollback could not be confirmed. They stay denied after admission stops: an unconfirmed wide sandbox must not silently run ungated calls. */

  /** A coexistence veto consulted before a takeover writes anything. */
  private enableGuard: EnableGuard | null = null;
  /** A tri-state reader, which can tell `unknown` from `stopped`. */
  private providerState: (() => ProviderState) | null = null;
  /** Whether this runtime currently takes over sessions (not master-off). */
  private active = false;
  /**
   * The fail-closed marks, their provenance and the widening holds: three
   * questions that share one lifetime, kept together.
   */
  /** The activation decisions that must outlive the request that made them. */
  private readonly hold = new CoverageHold();

  constructor(host: HostEnvironment) {
    this.host = host;
  }

  /** Install the pre-admission veto. Called once by the composition root with the coexistence monitor, so this service still owns "may this session be taken over" and the monitor owns "is another approval provider active". Nothing else is written here. */

  setEnableGuard(guard: EnableGuard | null): void {
    this.enableGuard = guard;
  }

  /** The tri-state provider answer. A veto that returns `null` only says "not refused"; it cannot distinguish a cleared conflict from a failed read. */

  setProviderState(read: (() => ProviderState) | null): void {
    this.providerState = read;
  }

  /** Whether an established restriction may be released. Only positive evidence releases it; `unknown` is missing evidence, and the contract forbids reading that as resolution. */

  private releasable(): boolean {
    const state = this.providerState?.();
    return state === undefined ? !this.conflictPresent() : state === 'stopped';
  }

  /** Whether coverage must not begin because the provider is unprovable. */
  private startUnprovable(): boolean {
    return this.providerState?.() === 'unknown';
  }

  /** Remember one session object so parent links and folds stay readable. */
  observe(session: SessionLike): void {
    if (typeof session.id === 'string') this.observed.set(session.id, session);
  }

  private sessionFor(id: string): SessionLike | undefined {
    const live = this.host.services.sessions?.get?.(id);
    return live ?? this.observed.get(id);
  }

  private known(id: string): boolean {
    return this.sessionFor(id) !== undefined;
  }

  /** Fold the latest admission record for one session id. */
  private admissionOf(id: string): FoldedAdmission | null {
    const session = this.sessionFor(id);
    if (session === undefined) return null;
    if (typeof session.snapshotEvents !== 'function') return null;
    const events = session.snapshotEvents();
    const last = events[events.length - 1];
    const lastSeq = last === undefined ? -1 : last.seq;
    const cached = this.cache.get(id);
    if (cached !== undefined && cached.lastSeq === lastSeq)
      return cached.folded;
    // The committed envelope is structurally what the record reader validates.
    // The owner guard keeps a fork seed's copied parent record out of it.
    const folded = foldAdmission(events, id);
    this.cache.set(id, { lastSeq, folded });
    return folded;
  }

  private lookup(): {
    readonly admissionOf: (id: string) => FoldedAdmission | null;
    readonly parentOf: (id: string) => string | undefined;
    readonly known: (id: string) => boolean;
  } {
    return {
      admissionOf: (id) => this.admissionOf(id),
      parentOf: (id) => this.sessionFor(id)?.header?.parentSession,
      known: (id) => this.known(id),
    };
  }

  /** The backend-confirmed view for one session. */
  view(id: string, revision: string): SessionAdmissionView | null {
    return sessionView(
      {
        known: (item) => this.known(item),
        lookup: () => this.lookup(),
        admissionOf: (item) => this.admissionOf(item),
        rootOf: (item) => this.rootOf(item),
        boundary: () => configuredBoundary(this.host.runtime.config),
        refused: () => this.hold.refusalStands && !this.releasable(),
      },
      id,
      revision,
    );
  }

  /** The session's own admission, or `null` when it has no valid record. */
  admission(id: string): SessionAdmission | null {
    const folded = this.admissionOf(id);
    if (folded === null) return null;
    return toAdmission(id, this.rootOf(id), folded);
  }

  /** The main session this one descends from: itself when it has no parent. A subagent can delegate again, so the answer is the top of the bounded parent chain — never just the immediate parent. An unresolvable or cyclic chain falls back to the first unresolved id, which no admission can match. */

  rootOf(id: string): string {
    const chain = parentChain(
      id,
      (sessionId) => this.sessionFor(sessionId)?.header?.parentSession,
    );
    if (chain.unresolved !== null) return chain.unresolved;
    return chain.ids[chain.ids.length - 1] ?? id;
  }

  /** Resolve whether a call from this session is covered by the gate. Recording coverage here is what lets teardown address exactly the sessions still managed; an unmanaged or retired session is dropped instead of being remembered as someone the plugin must roll back. */

  scopeFor(session: SessionLike): AdmissionScope {
    this.observe(session);
    const id = session.id;
    if (id === undefined) {
      return {
        managed: false,
        reason: 'parent-unresolved',
        admission: null,
        unresolvedParent: null,
      };
    }
    const scope = resolveScope(id, this.lookup());
    if (!scope.managed) {
      // Leaving managed scope ends gate protection, so any sandbox this plugin
      // widened is taken back here, not just dropped from the coverage set.
      this.releaseOnDrop(id, session);
      return scope;
    }
    // A refused resume keeps refusing; gating a restored session now is the
    // takeover the conflict forbade.
    if (this.hold.refusalStands) {
      if (!this.releasable()) return this.refuseCoverage(id, session, scope);
      this.hold.clear();
    }
    this.covered.set(id, session);
    // A cold restart can follow a configuration edit. Re-apply it here so the
    // first gated call already runs under the configured boundary.
    if (!this.syncOne(id, session)) {
      // Guarded is configured but the host will not confine this session, so a
      // review-allow would still execute outside the workspace. Refuse instead
      // of admitting: no call is approved while the promise cannot be kept.
      this.markFailingClosed(id);
      this.covered.delete(id);
      return {
        managed: false,
        reason: 'boundary-unconfirmed',
        admission: null,
        unresolvedParent: null,
      };
    }
    return scope;
  }

  /** Whether one session's withheld widening still applies. */
  private holdStill(
    id: string,
    recorded: ExecutionBoundary,
    configured: ExecutionBoundary,
  ): boolean {
    if (recorded === configured) return false;
    if (this.hold.isHeld(id) && !this.releasable()) return true;
    this.hold.release(id);
    return false;
  }

  /** Align one covered session with the configured boundary, lazily. */
  private syncOne(id: string, session: SessionLike): boolean {
    const boundary = configuredBoundary(this.host.runtime.config);
    const folded = this.admissionOf(id);
    if (folded === null) {
      if (boundary !== 'trusted')
        this.writeKnobs(session, narrowWrites(session));
      // A delegated child that cannot be narrowed must not run as an enabled
      // scope under a guarded configuration.
      return boundary !== 'guarded' || this.atSafeBoundary(session);
    }
    if (!folded.enabled) return true;
    // The record is not evidence of confinement: a guarded enable can commit
    // its record and then fail the sandbox write.
    const narrow = boundary === 'guarded' && !atSafeSandbox(session);
    if (folded.boundary === boundary && !narrow) return true;
    if (this.holdStill(id, folded.boundary, boundary)) return true;
    // A cold restore is an activation too, so it uses the same decision as
    // `enable()`: no widening under a conflict, narrowing recorded as applied.
    // A withheld widening is governed by the hold below; a *new* one must not
    // be granted on an unreadable provider either, so both the veto and the
    // tri-state feed the decision.
    const activation = activationOf(
      session,
      boundary,
      folded.boundary,
      this.conflictPresent() || this.startUnprovable(),
      true,
    );
    if (activation.writes.length === 0 && !narrow) return true;
    if (activation.withheld) this.hold.hold(id);
    this.writeKnobs(session, activation.writes);
    if (this.writeRecord(session, true, activation.boundary) !== 'written') {
      this.host.ctx.logger.warn(
        'arbiter: boundary sync for session %s could not be recorded',
        id,
      );
    }
    // Report whether the promise now holds, not whether a record was written.
    return boundary !== 'guarded' || this.atSafeBoundary(session);
  }

  /** Answer a call from a session that restored after coverage was refused. */
  private refuseCoverage(
    id: string,
    session: SessionLike,
    scope: AdmissionScope,
  ): AdmissionScope {
    return refuseLateRestore(
      this.host,
      this.adapters(),
      id,
      session,
      scope.admission?.boundary,
    );
  }

  /** Whether another approval provider is running right now (read-only). */
  private conflictPresent(): boolean {
    return (this.enableGuard?.() ?? null) !== null;
  }

  /** Restore every managed session's boundary for a configuration reason. */
  private releaseManagedScope(): void {
    this.discover();
    for (const [id, session] of this.teardownTargets()) {
      this.writeKnobs(session, exitWrites(session));
      if (this.atSafeBoundary(session)) continue;
      this.markFailingClosed(id);
      this.host.ctx.logger.error(
        'arbiter: session %s is not back at a safe boundary after being disabled',
        id,
      );
    }
  }

  /** Write the knob events, reporting whether every one committed. */
  private writeKnobs(
    session: SessionLike,
    writes: readonly KnobWrite[],
  ): boolean {
    if (typeof session.append !== 'function') return writes.length === 0;
    let written = true;
    for (const write of writes) {
      try {
        session.append(
          write.type,
          write.type === 'sandbox/mode'
            ? { mode: write.value }
            : { policy: write.value },
        );
      } catch {
        written = false;
      }
    }
    return written;
  }

  private writeRecord(
    session: SessionLike,
    enabled: boolean,
    boundary: ExecutionBoundary,
  ): RecordState {
    const id = session.id ?? 'unknown';
    return appendRecord(session, ADMISSION_RECORD_TYPE, {
      version: ADMISSION_VERSION,
      sessionId: id,
      rootSessionId: this.rootOf(id),
      enabled,
      boundary,
      at: Date.now(),
    });
  }

  private result(id: string): AdmissionResult {
    const view = this.view(id, this.host.runtime.effectiveRevision);
    return view === null
      ? { ok: false, code: 'session-unknown', message: `unknown ${id}` }
      : { ok: true, view };
  }

  private unavailable(id: string): AdmissionFailure | null {
    if (this.sessionFor(id) === undefined)
      return { ok: false, code: 'session-unknown', message: `unknown ${id}` };
    if (sessionRecordReady()) return null;
    return {
      ok: false,
      code: 'record-unavailable',
      message: 'the host session record API is unavailable',
    };
  }

  /** Everything `enable` must know before its first write, or the refusal. */
  private prepareEnable(id: string):
    | AdmissionFailure
    | {
        readonly session: SessionLike;
        readonly boundary: ExecutionBoundary;
        readonly wasManaged: boolean;
      } {
    const failure = this.unavailable(id);
    if (failure !== null) return failure;
    // Re-confirming a managed session is not a new takeover (the selector may
    // call enable idempotently), so a conflict only warns there.
    const admitted = this.admissionOf(id);
    // A refused resume means this admission is not a running gate, however its
    // retained record reads; treating it as one would let the API revive it.
    const wasManaged =
      admitted !== null && admitted.enabled && !this.hold.refusalStands;
    if (!wasManaged) {
      // A confirmed provider whose state is now unreadable is not a cleared
      // conflict: a *new* takeover waits for a readable observation.
      const veto = this.enableGuard?.() ?? null;
      if (veto !== null) return refuseEnable(this.host, id, veto);
      if (this.startUnprovable())
        return refuseEnable(this.host, id, unprovableVeto());
    }
    if (!this.host.runtime.config.enabled)
      return {
        ok: false,
        code: 'plugin-disabled',
        message: 'the plugin is disabled for this profile',
      };
    if (!this.host.runtime.accepting)
      return {
        ok: false,
        code: 'stopping',
        message: 'the plugin is stopping and no longer admits sessions',
      };
    const session = this.sessionFor(id);
    if (session === undefined)
      return { ok: false, code: 'session-unknown', message: `unknown ${id}` };
    this.observe(session);
    return {
      session,
      boundary: configuredBoundary(this.host.runtime.config),
      wasManaged,
    };
  }

  /** Enable one session under the configured boundary: the record lands first so the gate covers the session, then the boundary widens it. A failed record widens nothing, and a failed knob write leaves the session narrower. */

  enable(id: string): AdmissionResult {
    const prepared = this.prepareEnable(id);
    if ('ok' in prepared) return prepared;
    const { session, boundary, wasManaged } = prepared;
    // One decision drives every write below, so a withheld widening cannot
    // reappear through the record, the knobs or the next lazy sync.
    const {
      boundary: applied,
      writes,
      withheld,
    } = activationOf(
      session,
      boundary,
      this.admissionOf(id)?.boundary ?? 'guarded',
      this.conflictPresent() || this.startUnprovable(),
      wasManaged,
    );
    if (withheld) this.hold.hold(id);
    const state = this.writeRecord(session, true, applied);
    if (state !== 'written')
      return { ok: false, code: 'record-failed', message: state };
    this.covered.set(id, session);
    this.writeKnobs(session, writes);
    if (writes.length > 0) {
      const refreshed = this.writeRecord(session, true, applied);
      if (refreshed !== 'written') {
        this.host.ctx.logger.warn(
          'arbiter: boundary record for %s could not be refreshed: %s',
          id,
          refreshed,
        );
      }
    }
    // A guarded admission is only honest when the host really is confined.
    // Neither the record nor an absent sandbox event proves it: the deployment
    // default may be full access, and the sandbox write may have been refused.
    // Compensate in the log so a cold reader cannot believe an effective
    // guarded admission exists when the fence does not.
    // A withheld widening did not claim the configured boundary, so the
    // guarded-confinement obligation it implies does not apply.
    if (!withheld && applied === 'guarded' && !atSafeSandbox(session)) {
      // Keep protecting a managed session: withdrawing its record would hand
      // over an ungated session that is still wide. It stays fail-closed until a
      // later attempt confirms the narrowing.
      if (wasManaged) {
        this.markFailingClosed(id);
        this.host.ctx.logger.warn(
          'arbiter: guarded re-activation for session %s could not be confirmed; keeping it fail-closed',
          id,
        );
        return {
          ok: false,
          code: 'boundary-not-applied',
          message:
            'the host does not report workspace confinement; the session stays admitted but refused',
        };
      }
      this.covered.delete(id);
      const crossed = this.writeRecord(session, false, boundary);
      this.host.ctx.logger.warn(
        'arbiter: guarded activation for session %s could not be confirmed; admission withdrawn (%s)',
        id,
        crossed,
      );
      return {
        ok: false,
        code: 'boundary-not-applied',
        message:
          'the host does not report workspace confinement; guarded was not applied',
      };
    }
    return this.result(id);
  }

  /** Disable one session. A native switch already applied the user's own choice, so the record is the only new fact. An explicit API disable has no native target, so a boundary this plugin widened is narrowed back *before* the record removes gate protection; otherwise `trusted` would leave an ungated wide session. */

  disable(id: string, trigger: AdmissionTrigger): AdmissionResult {
    const failure = this.unavailable(id);
    if (failure !== null) return failure;
    const session = this.sessionFor(id);
    if (session === undefined)
      return { ok: false, code: 'session-unknown', message: `unknown ${id}` };
    this.observe(session);
    const current = this.admissionOf(id);
    const boundary =
      current?.boundary ?? configuredBoundary(this.host.runtime.config);
    // An API disable removes gate protection, so the boundary is confirmed
    // first: a refused narrowing must not be papered over by a record.
    if (trigger === 'api' && this.needsNarrowing(id, current)) {
      this.narrowCovered(session);
      if (!this.subtreeSafe(id, session)) {
        return {
          ok: false,
          code: 'boundary-unconfirmed',
          message:
            'the host did not confirm the narrowed sandbox; the session stays admitted',
        };
      }
    }
    const state = this.writeRecord(session, false, boundary);
    if (state !== 'written')
      return { ok: false, code: 'record-failed', message: state };
    this.covered.delete(id);
    return this.result(id);
  }

  /** Whether an API disable has anything to narrow. An inherited child has no record of its own but still runs under the parent's captured sandbox, so disabling it must narrow it too — otherwise the new disabled record would remove gate protection and leave the child at full access, which is worse than before the request. */

  private needsNarrowing(id: string, current: FoldedAdmission | null): boolean {
    if (current !== null) return current.enabled;
    const session = this.sessionFor(id);
    if (session === undefined) return false;
    if (session.header?.parentSession === undefined) return false;
    return this.covered.has(id) || narrowWrites(session).length > 0;
  }

  /** Stop protecting a session, taking back any permission this plugin widened. Dropping coverage is an admission exit in effect: the gate will no longer review this session's calls, so a sandbox the plugin widened must not stay behind. Only a session this plugin actually covered is touched — an ordinary session that was never admitted keeps whatever its user chose. */

  private releaseOnDrop(id: string, session: SessionLike): void {
    const covered = this.covered.has(id);
    this.covered.delete(id);
    // Narrow when this session was covered and is still wide, or when it is a
    // delegated child carrying a sandbox wider than full access — the captured
    // privilege a parent's exit can leave behind without ever covering it here.
    const delegated = session.header?.parentSession !== undefined;
    if ((!covered && !delegated) || this.atSafeBoundary(session)) return;
    if (!this.narrowSession(session)) this.markFailingClosed(id);
  }

  /** Narrow every still-managed descendant of a session that just left. */
  settleDescendants(rootId: string): number {
    return narrowBranch(this.teardownView(), rootId);
  }

  /** Whether the session being disabled and everything below it is safe. */
  private subtreeSafe(rootId: string, root: SessionLike): boolean {
    return (
      this.atSafeBoundary(root) && subtreeIsSafe(this.teardownView(), rootId)
    );
  }

  /** The view the subtree rules read. */
  private teardownView(): TeardownView {
    return teardownViewOf({
      covered: this.covered,
      atSafeBoundary: (session) => this.atSafeBoundary(session),
      isDescendantOf: (id, ancestor) => this.isDescendantOf(id, ancestor),
      narrowSession: (session) => this.narrowSession(session),
      markFailingClosed: (id) => {
        this.markFailingClosed(id);
      },
      dropCoverage: (id) => {
        this.covered.delete(id);
      },
      observeForBranch: (session) => {
        this.observe(session);
      },
      liveSessions: () => this.host.services.sessions?.list?.() ?? [],
    });
  }

  /** Whether `id` sits below `ancestor` in the bounded parent chain. */
  isDescendantOf = (id: string, ancestor: string): boolean =>
    descendantOf(
      id,
      ancestor,
      (sessionId) => this.sessionFor(sessionId)?.header?.parentSession,
    );

  readonly atSafeSandbox = (session: SessionLike): boolean =>
    atSafeSandbox(session);

  /** Whether this session already satisfies what teardown must restore. */
  atSafeBoundary = (session: SessionLike): boolean => boundaryIsSafe(session);

  /** Narrow one session, retrying: this is the last protection before exit. */
  narrowSession = (session: SessionLike, attempts = 3): boolean =>
    narrowWithRetry(session, this.adapters(), attempts);

  /** Narrow one covered session and every covered session inheriting it. */
  private narrowCovered(root: SessionLike): void {
    this.discover();
    const rootId = root.id ?? '';
    this.writeKnobs(root, exitWrites(root));
    for (const [id, session] of this.teardownView().branchCandidates()) {
      if (id === rootId || !this.isDescendantOf(id, rootId)) continue;
      this.writeKnobs(session, narrowWrites(session));
    }
  }

  /** Re-apply the effective boundary after a configuration activation. */
  syncBoundary(config: ArbiterConfig): void {
    applyBoundary(this.host, this.boundaryView(), config);
  }

  /** The view the configuration sync reads; each member forwards to this. */
  private boundaryView(): BoundarySync {
    return {
      ...this.adapters(),
      covered: this.covered,
      active: this.active,
      refusalStands: this.hold.refusalStands,
      releasable: () => this.releasable(),
      vetoPresent: () => this.conflictPresent(),
      triState: () => this.providerState !== null,
      unprovable: () => this.startUnprovable(),
      veto: () => this.enableGuard?.() ?? null,
      setActive: (next) => {
        this.active = next;
      },
      hold: (id) => {
        this.hold.hold(id);
      },
      release: (id) => {
        this.hold.release(id);
      },
      isHeld: (id) => this.hold.isHeld(id),
      refuse: () => {
        this.hold.refuse();
      },
      clearRefusal: () => {
        this.hold.clear();
      },
      retained: (id) => {
        const folded = this.admissionOf(id);
        return folded === null
          ? null
          : { enabled: folded.enabled, boundary: folded.boundary };
      },
      releaseManagedScope: () => {
        this.releaseManagedScope();
      },
    };
  }

  /** Add every live session carrying an enabled admission to the coverage set. Teardown must not rely on which sessions happened to call the gate: a session restored from a previous run can be live, trusted and admitted without this process having seen a single gated call from it. The host's public `sessions.list()` is the enumeration source; when it is absent the already-covered set stays the only known scope, which is reported. */

  discover(): number {
    const sessions = this.host.services.sessions;
    if (sessions?.list === undefined) return 0;
    // Two passes: the first observes every live session so parent chains can
    // resolve, the second classifies each one by its *effective* scope. A
    // subagent has no record of its own, so classifying on the record alone
    // would drop exactly the inherited sessions teardown must still narrow.
    const live = sessions.list();
    for (const session of live) this.observe(session);
    let found = 0;
    for (const session of live) {
      const id = session.id;
      if (id === undefined) continue;
      const scope = resolveScope(id, this.lookup());
      if (!scope.managed) {
        this.releaseOnDrop(id, session);
        continue;
      }
      if (!this.covered.has(id)) found += 1;
      this.covered.set(id, session);
    }
    return found;
  }

  /** Bring one late-restored session back to a safe boundary, or report it. */
  releaseOne(session: SessionLike): 'safe' | 'narrowed' | 'unsafe' {
    return releaseLateSession(session, {
      observe: (item) => {
        this.observe(item);
      },
      lookup: () => this.lookup(),
      covered: this.covered,
      atSafeBoundary: (item) => this.atSafeBoundary(item),
      narrowSession: (item) => this.narrowSession(item),
    });
  }

  /** Sessions covered by an enabled admission at this moment. */
  coveredSessions(): readonly (readonly [string, SessionLike])[] {
    return [...this.covered];
  }
  /** Everything teardown must restore, as the sync and release paths read it. */
  teardownTargets(): readonly (readonly [string, SessionLike])[] {
    return [...this.covered].filter(([id]) => {
      const folded = this.admissionOf(id);
      return folded === null || folded.enabled;
    });
  }

  markFailingClosed(sessionId: string, byRefusal = false): void {
    this.hold.mark(sessionId, byRefusal);
  }
  isFailingClosed = (sessionId: string | undefined): boolean =>
    this.hold.isMarked(sessionId);
  isRefusalMarked = (sessionId: string | undefined): boolean =>
    this.hold.isRefusalMarked(sessionId);

  /** Summary projection for the state payload. */
  summary(): unknown {
    return admissionSummary(this.host, {
      coveredIds: [...this.covered.keys()],
      failingClosed: this.hold.markedIds(),
      admission: (id) => this.admission(id),
    });
  }

  /** The adapters a resume refusal and narrowing need; each forwards to this. */
  adapters(): AdmissionAdapters {
    return {
      resumeTargets: () => (this.discover(), this.teardownTargets()),
      writeAdmission: (session, enabled, boundary) =>
        this.writeRecord(session, enabled, boundary),
      writeSessionKnobs: (session, writes) => {
        this.writeKnobs(session, writes);
      },
      dropCoverage: (id) => {
        this.covered.delete(id);
      },
      atSafeSandbox: (session) => atSafeSandbox(session),
      markFailingClosed: (id, byRefusal) => {
        this.markFailingClosed(id, byRefusal);
      },
    };
  }

  /** Sessions still awaiting a confirmed rollback, for reporting. */
  failingClosedSessions(): readonly string[] {
    return this.hold.markedIds();
  }

  clearFailingClosed(sessionId: string): void {
    this.hold.clearMark(sessionId);
  }
}
