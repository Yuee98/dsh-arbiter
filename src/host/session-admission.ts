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
import type { SessionLike } from '../snapshot.js';
import type {
  AdmissionScope,
  ArbiterConfig,
  ExecutionBoundary,
  SessionAdmission,
  SessionAdmissionView,
} from '../types.js';
import {
  ADMISSION_RECORD_TYPE,
  ADMISSION_VERSION,
  boundaryKnobs,
  configuredBoundary,
  foldAdmission,
  parentChain,
  resolveScope,
  toAdmission,
} from './admission.js';
import type { FoldedAdmission } from './admission.js';
import type { HostEnvironment } from './types.js';

export type AdmissionTrigger = 'api' | 'permission-command' | 'boundary-sync';

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
    | 'invalid-action';
  readonly message: string;
}

export type AdmissionResult =
  { readonly ok: true; readonly view: SessionAdmissionView } | AdmissionFailure;

interface CacheEntry {
  readonly lastSeq: number;
  readonly folded: FoldedAdmission | null;
}

interface Knobs {
  readonly sandbox: string | null;
  readonly approval: string | null;
}

interface KnobWrite {
  readonly type: 'sandbox/mode' | 'approval/policy';
  readonly value: string;
}

export class SessionAdmissions {
  private readonly host: HostEnvironment;
  /** Fold cache keyed by session id and guarded by the last committed seq. */
  private readonly cache = new Map<string, CacheEntry>();
  /** Sessions this runtime has read; a parent may already be out of the store. */
  private readonly observed = new Map<string, SessionLike>();
  /** Sessions inside an enabled admission, for boundary sync and teardown. */
  private readonly covered = new Map<string, SessionLike>();
  /**
   * Sessions whose teardown rollback could not be confirmed. They stay denied
   * after admission stops: an unconfirmed wide sandbox must not silently run
   * ungated calls.
   */
  private readonly failingClosed = new Set<string>();

  constructor(host: HostEnvironment) {
    this.host = host;
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

  /** The session's own admission, or `null` when it has no valid record. */
  admission(id: string): SessionAdmission | null {
    const folded = this.admissionOf(id);
    if (folded === null) return null;
    return toAdmission(id, this.rootOf(id), folded);
  }

  /**
   * The main session this one descends from: itself when it has no parent.
   *
   * A subagent can delegate again, so the answer is the top of the bounded
   * parent chain — never just the immediate parent. An unresolvable or cyclic
   * chain falls back to the first unresolved id, which no admission can match.
   */
  rootOf(id: string): string {
    const chain = parentChain(
      id,
      (sessionId) => this.sessionFor(sessionId)?.header?.parentSession,
    );
    if (chain.unresolved !== null) return chain.unresolved;
    return chain.ids[chain.ids.length - 1] ?? id;
  }

  /**
   * Resolve whether a call from this session is covered by the gate.
   *
   * Recording coverage here is what lets teardown address exactly the sessions
   * still managed; an unmanaged or retired session is dropped instead of being
   * remembered as someone the plugin must roll back.
   */
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
    this.covered.set(id, session);
    // A cold restart can follow a configuration edit that changed the
    // boundary while the plugin was unloaded. Re-apply it here, lazily, so the
    // first gated call already runs under the configured boundary instead of
    // the one recorded when the session was enabled.
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

  /**
   * Align one covered session with the effective boundary.
   *
   * Runs on the first covered call after a reload, which is the point where a
   * configuration edit and a still-running session meet:
   *   - a session with its own enabled record follows the configured boundary
   *     and records the change;
   *   - an inherited scope has no record and is only ever narrowed, because the
   *     host captured its sandbox at delegation and this plugin never widened
   *     a child on purpose.
   */
  private syncOne(id: string, session: SessionLike): boolean {
    const boundary = configuredBoundary(this.host.runtime.config);
    const folded = this.admissionOf(id);
    if (folded === null) {
      if (boundary !== 'trusted') {
        this.writeKnobs(session, this.narrowWrites(session));
      }
      // A delegated child that cannot be narrowed must not run as an enabled
      // scope under a guarded configuration.
      return boundary !== 'guarded' || this.atSafeBoundary(session);
    }
    if (!folded.enabled) return true;
    // The record is not evidence that the host is confined: a guarded enable
    // can have committed its record and then failed to write the sandbox. Only
    // the live host value proves the boundary is in force.
    const narrow = boundary === 'guarded' && !this.confined(session);
    if (folded.boundary === boundary && !narrow) return true;
    this.writeKnobs(session, this.boundaryWrites(session, boundary));
    if (this.writeRecord(session, true, boundary) !== 'written') {
      this.host.ctx.logger.warn(
        'arbiter: boundary sync for session %s could not be recorded',
        id,
      );
    }
    // Report whether the promise now holds, not whether a record was written.
    return boundary !== 'guarded' || this.atSafeBoundary(session);
  }

  /**
   * Bring every managed session back to a safe host boundary.
   *
   * Used when the gate stops protecting sessions for a configuration reason
   * (master switch off) rather than an unload; the admission records stay, so a
   * later re-enable of the plugin can restore the sessions it still covers.
   */
  private releaseManagedScope(): void {
    this.discover();
    for (const [id, session] of this.teardownTargets()) {
      // Main sessions return to the guarded bundle (sandbox + ask); a
      // delegated child only loses its captured sandbox, because the host
      // pinned its approval at delegation.
      this.writeKnobs(
        session,
        session.header?.parentSession === undefined
          ? this.boundaryWrites(session, 'guarded')
          : this.narrowWrites(session),
      );
      if (!this.atSafeBoundary(session)) {
        this.markFailingClosed(id);
        this.host.ctx.logger.error(
          'arbiter: session %s is not back at a safe boundary after the plugin was disabled',
          id,
        );
      }
    }
  }

  /** The backend-confirmed view for one session, under one config revision. */
  view(id: string, revision: string): SessionAdmissionView | null {
    if (!this.known(id)) return null;
    const scope = resolveScope(id, this.lookup());
    const admission = this.admission(id);
    return {
      sessionId: id,
      rootSessionId: this.rootOf(id),
      enabled: admission?.enabled ?? false,
      boundary:
        admission?.boundary ?? configuredBoundary(this.host.runtime.config),
      revision,
      admissionRevision: admission?.admissionRevision ?? null,
      seq: admission?.seq ?? null,
      at: admission?.at ?? null,
      reason: scope.reason,
      managed: scope.managed,
    };
  }

  private knobsOf(session: SessionLike): Knobs {
    let sandbox: string | null = null;
    let approval: string | null = null;
    if (typeof session.snapshotEvents !== 'function') {
      return { sandbox, approval };
    }
    for (const event of session.snapshotEvents()) {
      const data: unknown = event.data;
      if (data === null || typeof data !== 'object') continue;
      const record: Readonly<Record<string, unknown>> = { ...data };
      if (event.type === 'sandbox/mode' && typeof record['mode'] === 'string')
        sandbox = record['mode'];
      if (
        event.type === 'approval/policy' &&
        typeof record['policy'] === 'string'
      )
        approval = record['policy'];
    }
    return { sandbox, approval };
  }

  /**
   * The knob changes one boundary needs on this session.
   *
   * A subagent is never rewritten: the host pins delegated approval and
   * captures the parent's sandbox, and widening that from inside would grant a
   * child more than its delegation carried. An absent knob means the
   * deployment default applies, which is the host's choice, not this plugin's.
   */
  private boundaryWrites(
    session: SessionLike,
    boundary: ExecutionBoundary,
  ): readonly KnobWrite[] {
    if (session.header?.parentSession !== undefined) return [];
    const target = boundaryKnobs(boundary);
    const current = this.knobsOf(session);
    const writes: KnobWrite[] = [];
    // An absent event is not evidence that the deployment default matches the
    // target: the default can be full access. A managed session states its
    // boundary explicitly so the log, not an assumption, carries it.
    if (current.sandbox !== target.sandbox) {
      writes.push({ type: 'sandbox/mode', value: target.sandbox });
    }
    if (current.approval !== target.approval) {
      writes.push({ type: 'approval/policy', value: target.approval });
    }
    return writes;
  }

  /**
   * The narrowing a still-covered session needs to stop running wide.
   *
   * A subagent never gets its knobs widened by this plugin, but the host
   * captures the parent's sandbox at delegation, so a child of a trusted root
   * can be running `danger-full-access` without any record of its own. When the
   * plugin stops taking over (explicit disable, unload, a boundary change) that
   * captured sandbox must be narrowed too, or the child would execute new
   * unreviewed calls with the parent's old privilege.
   *
   * Only the sandbox is touched: the host pins a delegated child's approval to
   * `never`, and replacing that would open prompts the delegation never had.
   */
  private narrowWrites(session: SessionLike): readonly KnobWrite[] {
    // Only a value that is actually wider is rewritten. Absent is not rewritten
    // here because this narrowing must never widen a session the host confined
    // more strictly (a child captured read-only or an explicit read-only
    // choice); `atSafeBoundary` still refuses to call absent "safe".
    if (this.knobsOf(session).sandbox !== 'danger-full-access') return [];
    return [{ type: 'sandbox/mode', value: 'workspace-write' }];
  }

  /**
   * Write the knob events, reporting whether every one committed.
   *
   * A host can refuse an append while it is publishing another commit; the
   * caller must know so it can verify the real boundary instead of assuming
   * the write landed.
   */
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
  ): string {
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
      ? {
          ok: false,
          code: 'session-unknown',
          message: `unknown session ${id}`,
        }
      : { ok: true, view };
  }

  private unavailable(id: string): AdmissionFailure | null {
    if (this.sessionFor(id) === undefined) {
      return {
        ok: false,
        code: 'session-unknown',
        message: `unknown session ${id}`,
      };
    }
    if (!sessionRecordReady()) {
      return {
        ok: false,
        code: 'record-unavailable',
        message: 'the host session record API is unavailable',
      };
    }
    return null;
  }

  /**
   * Enable one session under the configured boundary.
   *
   * Order matters: the admission record lands first so the gate already covers
   * the session, then the boundary widens it. If the record cannot be written
   * nothing is widened; if a knob write then fails the session stays admitted
   * and narrower, which is the safe direction. The host has no cross-event
   * transaction, so this ordering — not a rollback — is what prevents an
   * ungated wide session.
   *
   * Activation is refused while the plugin master switch is off or teardown
   * has begun: the gate would not protect the session it just widened.
   */
  enable(id: string): AdmissionResult {
    const failure = this.unavailable(id);
    if (failure !== null) return failure;
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
    const boundary = configuredBoundary(this.host.runtime.config);
    // Whether this session was already managed before this request. It decides
    // what a failed guarded activation may undo: a fresh enable can be
    // withdrawn, but a session that was already admitted must not lose gate
    // protection while it still holds a permission this plugin widened.
    const previously = this.admissionOf(id);
    const wasManaged = previously !== null && previously.enabled;
    const state = this.writeRecord(session, true, boundary);
    if (state !== 'written')
      return { ok: false, code: 'record-failed', message: state };
    this.covered.set(id, session);
    const writes = this.boundaryWrites(session, boundary);
    this.writeKnobs(session, writes);
    if (writes.length > 0) {
      const applied = this.writeRecord(session, true, boundary);
      if (applied !== 'written') {
        this.host.ctx.logger.warn(
          'arbiter: boundary record for %s could not be refreshed: %s',
          id,
          applied,
        );
      }
    }
    // A guarded admission is only honest when the host really is confined.
    // Neither the record nor an absent sandbox event proves it: the deployment
    // default may be full access, and the sandbox write may have been refused.
    // Compensate in the log so a cold reader cannot believe an effective
    // guarded admission exists when the fence does not.
    if (boundary === 'guarded' && !this.confined(session)) {
      // Keep protecting a session that was already managed: withdrawing its
      // record would hand over an ungated session that is still wide. It stays
      // fail-closed (see refuseUnconfirmed) until a later attempt confirms the
      // narrowing, which also keeps the recovery direction open.
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

  /**
   * Disable one session.
   *
   * Two exit sources differ in what happens to host permissions:
   *   - a native permission switch already applied the user's own choice, so
   *     the record is the only new fact;
   *   - an explicit API disable has no native target, so a boundary this
   *     plugin widened is narrowed back to workspace-write + ask *before* the
   *     record removes gate protection. Otherwise `trusted` would leave a
   *     danger-full-access session that no longer passes the gate.
   */
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
    // An API disable removes gate protection, so the host boundary must be
    // confirmed FIRST. A narrowing the host refuses must not be papered over by
    // a committed disable record: the next call would then run wide and
    // ungated. The gate stays in place until the narrowing is real.
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

  /**
   * Whether an API disable has anything to narrow.
   *
   * An inherited child has no record of its own but still runs under the
   * parent's captured sandbox, so disabling it must narrow it too — otherwise
   * the new disabled record would remove gate protection and leave the child
   * at full access, which is worse than before the request.
   */
  private needsNarrowing(id: string, current: FoldedAdmission | null): boolean {
    if (current !== null) return current.enabled;
    const session = this.sessionFor(id);
    if (session === undefined) return false;
    if (session.header?.parentSession === undefined) return false;
    return this.covered.has(id) || this.narrowWrites(session).length > 0;
  }

  /**
   * Stop protecting a session, taking back any permission this plugin widened.
   *
   * Dropping coverage is an admission exit in effect: the gate will no longer
   * review this session's calls, so a sandbox the plugin widened must not stay
   * behind. Only a session this plugin actually covered is touched — an
   * ordinary session that was never admitted keeps whatever its user chose.
   */
  private releaseOnDrop(id: string, session: SessionLike): void {
    const covered = this.covered.has(id);
    this.covered.delete(id);
    // Narrow when this session was covered and is still wide, or when it is a
    // delegated child carrying a sandbox wider than full access — the captured
    // privilege a parent's exit can leave behind without ever covering it here.
    const delegated = session.header?.parentSession !== undefined;
    if (!covered && !delegated) return;
    if (this.atSafeBoundary(session)) return;
    if (!this.narrowSession(session)) this.markFailingClosed(id);
  }

  /**
   * Narrow every still-managed descendant of a session that just left.
   *
   * A parent's exit — native or API — only changes the parent's own host
   * sandbox. Children captured the parent's sandbox at delegation and have no
   * record to fold, so once the parent is disabled they would resolve as
   * `parent-not-admitted` and run ungated with the parent's old privilege. This
   * closes that gap for every descendant still known to the plugin, including
   * ones discovered from the live session list.
   *
   * The parent's own permission is never touched here: a native exit already
   * applied the user's choice, and an API disable narrows before this runs.
   */
  settleDescendants(rootId: string): number {
    // Do not call discover() here: it prunes by the *current* scope, and by the
    // time this runs the parent already folds as disabled, so every descendant
    // would be classified unmanaged and dropped before it could be narrowed.
    // Candidates come from the live list plus whatever is already covered, and
    // the parent chain alone decides who belongs to this branch.
    const candidates = new Map<string, SessionLike>();
    for (const [id, session] of this.covered) candidates.set(id, session);
    const sessions = this.host.services.sessions;
    if (sessions?.list !== undefined) {
      for (const session of sessions.list()) {
        const id = session.id;
        if (id === undefined) continue;
        this.observe(session);
        candidates.set(id, session);
      }
    }
    let narrowed = 0;
    for (const [id, session] of candidates) {
      if (id === rootId) continue;
      if (!this.isDescendantOf(id, rootId)) continue;
      if (this.atSafeBoundary(session)) continue;
      if (this.narrowSession(session)) narrowed += 1;
      else this.markFailingClosed(id);
      this.covered.delete(id);
    }
    return narrowed;
  }

  /**
   * Whether the session being disabled and everything below it is safe.
   *
   * The subtree, not the whole branch: disabling a child must not demand that
   * its still-admitted parent is already narrowed — the parent's own exit is
   * what narrows it.
   */
  private subtreeSafe(rootId: string, root: SessionLike): boolean {
    if (!this.atSafeBoundary(root)) return false;
    for (const [id, session] of this.covered) {
      if (id === rootId) continue;
      if (!this.isDescendantOf(id, rootId)) continue;
      if (!this.atSafeBoundary(session)) return false;
    }
    return true;
  }

  /** Whether `id` sits below `ancestor` in the bounded parent chain. */
  private isDescendantOf(id: string, ancestor: string): boolean {
    const chain = parentChain(
      id,
      (sessionId) => this.sessionFor(sessionId)?.header?.parentSession,
    );
    return chain.ids.slice(1).includes(ancestor);
  }

  /**
   * Whether the host currently confines this session to the workspace.
   *
   * An absent sandbox event is not proof of confinement: the deployment
   * default can be full access, so only an observed workspace-write counts.
   */
  /** Whether the observed sandbox is a value this plugin can call safe. */
  private atSafeSandbox(session: SessionLike): boolean {
    const sandbox = this.knobsOf(session).sandbox;
    return sandbox === 'workspace-write' || sandbox === 'read-only';
  }

  private confined(session: SessionLike): boolean {
    const sandbox = this.knobsOf(session).sandbox;
    return sandbox === 'workspace-write' || sandbox === 'read-only';
  }

  /**
   * Whether this session already satisfies everything teardown must restore.
   *
   * A main session must end at `workspace-write + ask`; a delegated child only
   * needs its captured sandbox narrowed, because the host pinned its approval
   * policy at delegation and this plugin must not rewrite it.
   */
  atSafeBoundary(session: SessionLike): boolean {
    const current = this.knobsOf(session);
    // A delegated child is never widened by this plugin, so its obligations are
    // narrower: it must not sit at full access, and an absent value is left to
    // the host's own delegation defaults.
    if (session.header?.parentSession !== undefined) {
      return current.sandbox !== 'danger-full-access';
    }
    // A main session is the one this plugin widened, so both halves of the
    // bundle must be observed: an absent sandbox event can mean a full-access
    // deployment default, and `ask` is what the widening replaced.
    return (
      current.sandbox !== null &&
      current.sandbox !== 'danger-full-access' &&
      current.approval === 'ask'
    );
  }

  /**
   * Narrow one session, retrying a bounded number of times.
   *
   * The write is the last protection before gate protection ends, so a single
   * transient append failure must not leave the session wide. A failure that
   * persists is reported to the caller, which keeps the session refused.
   */
  narrowSession(session: SessionLike, attempts = 3): boolean {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      if (typeof session.append !== 'function') return false;
      try {
        // Write the explicit safe sandbox whenever the observed value is not
        // already safe, including when it is absent: an absent override can
        // fall back to a full-access deployment default.
        if (!this.atSafeSandbox(session)) {
          this.writeKnobs(session, [
            { type: 'sandbox/mode', value: 'workspace-write' },
          ]);
        }
        if (this.atSafeSandbox(session)) return true;
      } catch {
        // Retry: the host may still be publishing another append.
      }
    }
    return false;
  }

  /**
   * Narrow the sandbox of one covered session and of every covered session
   * that inherits its admission.
   *
   * The root's own narrowing is the configured guarded bundle; a descendant
   * only ever needs its captured sandbox narrowed, never its pinned approval.
   */
  private narrowCovered(root: SessionLike): void {
    // A live descendant may never have reached the gate, so pick up the whole
    // branch before narrowing instead of trusting only what has been observed.
    this.discover();
    const rootId = root.id ?? '';
    // The root of a delegated branch keeps its pinned approval; only a main
    // session returns to the full guarded bundle. Descendants always narrow to
    // the sandbox alone.
    this.writeKnobs(
      root,
      root.header?.parentSession === undefined
        ? this.boundaryWrites(root, 'guarded')
        : this.narrowWrites(root),
    );
    for (const [id, session] of this.covered) {
      if (id === rootId) continue;
      if (!this.isDescendantOf(id, rootId)) continue;
      this.writeKnobs(session, this.narrowWrites(session));
    }
  }

  /**
   * Re-apply the effective boundary to sessions that are still enabled.
   *
   * Runs only after a configuration activation, so a boundary change never
   * enables a session and never rewrites one that left.
   */
  syncBoundary(config: ArbiterConfig): void {
    const boundary = configuredBoundary(config);
    if (!config.enabled) {
      // The master switch turning off stops the gate, so a session this plugin
      // widened would become ungated while keeping that permission. Narrow the
      // whole managed scope first: the same direction as teardown.
      this.releaseManagedScope();
      return;
    }
    for (const [id, session] of this.covered) {
      const folded = this.admissionOf(id);
      if (folded === null) {
        // An inherited scope has no record of its own: when its root narrows,
        // the sandbox the host captured at delegation must narrow with it.
        if (boundary !== 'trusted') {
          this.writeKnobs(session, this.narrowWrites(session));
        }
        continue;
      }
      if (!folded.enabled) {
        this.covered.delete(id);
        continue;
      }
      if (folded.boundary === boundary) continue;
      const writes = this.boundaryWrites(session, boundary);
      if (writes.length === 0) continue;
      this.writeKnobs(session, writes);
      const state = this.writeRecord(session, true, boundary);
      if (state !== 'written') {
        this.host.ctx.logger.warn(
          'arbiter: boundary sync for session %s failed: %s',
          id,
          state,
        );
        continue;
      }
      this.host.ctx.logger.info(
        'arbiter: session %s moved to boundary %s',
        id,
        boundary,
      );
    }
  }

  /**
   * Add every live session carrying an enabled admission to the coverage set.
   *
   * Teardown must not rely on which sessions happened to call the gate: a
   * session restored from a previous run can be live, trusted and admitted
   * without this process having seen a single gated call from it. The host's
   * public `sessions.list()` is the enumeration source; when it is absent the
   * already-covered set stays the only known scope, which is reported.
   */
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

  /**
   * Bring one session back to a safe boundary without writing an admission
   * record. Used when the gate is already stepping aside: a session that
   * becomes live after the reconcile ran still carries the permission this
   * plugin widened, and there is no later moment to take it back.
   *
   * Returns `safe` when nothing was needed, `narrowed` when the host confirmed
   * the write, and `unsafe` when a session is still wide — the caller must not
   * let that call through.
   */
  releaseOne(session: SessionLike): 'safe' | 'narrowed' | 'unsafe' {
    this.observe(session);
    const id = session.id;
    if (id === undefined) return 'safe';
    const scope = resolveScope(id, this.lookup());
    // Only a session that would be managed needs narrowing; ordinary
    // unadmitted sessions are never subject to this plugin's permission.
    if (!scope.managed && !this.covered.has(id)) return 'safe';
    if (this.atSafeBoundary(session)) return 'safe';
    const narrowed = this.narrowSession(session);
    if (!this.atSafeBoundary(session)) return 'unsafe';
    return narrowed ? 'narrowed' : 'safe';
  }

  /** Sessions covered by an enabled admission at this moment. */
  coveredSessions(): readonly (readonly [string, SessionLike])[] {
    return [...this.covered];
  }

  /**
   * Everything teardown must bring back to a safe host boundary.
   *
   * A session is included when it is covered (its own or an inherited
   * admission) and its own record does not already say "disabled": a session
   * that left keeps its own permission, while every still-managed session —
   * main or descendant — is narrowed before admission stops.
   */
  teardownTargets(): readonly (readonly [string, SessionLike])[] {
    const targets: (readonly [string, SessionLike])[] = [];
    for (const [id, session] of this.covered) {
      const folded = this.admissionOf(id);
      if (folded !== null && !folded.enabled) continue;
      targets.push([id, session]);
    }
    return targets;
  }

  /** Remember that this session could not be brought back to a safe boundary. */
  markFailingClosed(sessionId: string): void {
    this.failingClosed.add(sessionId);
  }

  /** Whether a call from this session must still be refused after teardown. */
  isFailingClosed(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.failingClosed.has(sessionId);
  }

  /** Sessions still awaiting a confirmed rollback, for reporting. */
  failingClosedSessions(): readonly string[] {
    return [...this.failingClosed];
  }

  /** The session reached a safe boundary on a later attempt. */
  clearFailingClosed(sessionId: string): void {
    this.failingClosed.delete(sessionId);
  }

  /** One bounded summary for the state payload. */
  summary(): unknown {
    return {
      boundary: configuredBoundary(this.host.runtime.config),
      covered: this.covered.size,
      // A session the plugin widened and could not narrow again: a human must
      // reselect its permission, because the plugin no longer gates it.
      failingClosed: [...this.failingClosed],
      sessions: [...this.covered.keys()].slice(-20).map((id) => {
        const admission = this.admission(id);
        return admission === null
          ? { sessionId: id, admission: null }
          : { sessionId: id, admission };
      }),
    };
  }
}
