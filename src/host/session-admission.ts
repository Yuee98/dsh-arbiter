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
      this.covered.delete(id);
      return scope;
    }
    this.covered.set(id, session);
    // A cold restart can follow a configuration edit that changed the
    // boundary while the plugin was unloaded. Re-apply it here, lazily, so the
    // first gated call already runs under the configured boundary instead of
    // the one recorded when the session was enabled.
    this.syncOne(id, session);
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
  private syncOne(id: string, session: SessionLike): void {
    const boundary = configuredBoundary(this.host.runtime.config);
    const folded = this.admissionOf(id);
    if (folded === null) {
      if (boundary !== 'trusted') {
        this.writeKnobs(session, this.narrowWrites(session));
      }
      return;
    }
    if (!folded.enabled || folded.boundary === boundary) return;
    this.writeKnobs(session, this.boundaryWrites(session, boundary));
    if (this.writeRecord(session, true, boundary) === 'written') return;
    this.host.ctx.logger.warn(
      'arbiter: boundary sync for session %s could not be recorded',
      id,
    );
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
    if (current.sandbox !== null && current.sandbox !== target.sandbox) {
      writes.push({ type: 'sandbox/mode', value: target.sandbox });
    }
    if (current.approval !== null && current.approval !== target.approval) {
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
    const current = this.knobsOf(session);
    if (current.sandbox === null || current.sandbox === 'workspace-write')
      return [];
    return [{ type: 'sandbox/mode', value: 'workspace-write' }];
  }

  private writeKnobs(session: SessionLike, writes: readonly KnobWrite[]): void {
    if (typeof session.append !== 'function') return;
    for (const write of writes) {
      session.append(
        write.type,
        write.type === 'sandbox/mode'
          ? { mode: write.value }
          : { policy: write.value },
      );
    }
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
    // Enabling a session that already sits at danger-full-access cannot claim
    // guarded: the record must describe the sandbox in force, or a cold reader
    // would believe the workspace fence exists when it does not.
    const effective = this.knobsOf(session).sandbox;
    if (boundary === 'guarded' && effective === 'danger-full-access') {
      return {
        ok: false,
        code: 'boundary-not-applied',
        message:
          'the host still reports danger-full-access; guarded was not applied',
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
    if (trigger === 'api' && current !== null && current.enabled) {
      this.narrowCovered(session);
    }
    const state = this.writeRecord(session, false, boundary);
    if (state !== 'written')
      return { ok: false, code: 'record-failed', message: state };
    this.covered.delete(id);
    return this.result(id);
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
        const writes = this.narrowWrites(session);
        if (writes.length === 0) return true;
        this.writeKnobs(session, writes);
        const current = this.knobsOf(session);
        if (current.sandbox === null || current.sandbox === 'workspace-write')
          return true;
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
    this.writeKnobs(root, this.boundaryWrites(root, 'guarded'));
    for (const [id, session] of this.covered) {
      if (id === root.id) continue;
      if (this.rootOf(id) !== root.id) continue;
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
    let found = 0;
    for (const session of sessions.list()) {
      this.observe(session);
      const id = session.id;
      if (id === undefined) continue;
      const folded = this.admissionOf(id);
      if (folded === null || !folded.enabled) {
        this.covered.delete(id);
        continue;
      }
      if (!this.covered.has(id)) found += 1;
      this.covered.set(id, session);
    }
    return found;
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
