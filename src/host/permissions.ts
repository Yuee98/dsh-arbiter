import { refusalRecovered } from './admission-release.js';
import type { SessionLike } from '../snapshot.js';
import type { HostEnvironment, TurnSessionLike } from './types.js';
import type { DecisionHistory } from './history.js';
import { isRecord } from './common.js';
import { releaseRuntime } from './runtime.js';
import type { SessionAdmissions } from './session-admission.js';

export const UNLOAD_DRAIN_MS = 30_000;
export const AUTO_REJECTION_HINT =
  '此入口不受 Arbiter 支持。请在会话权限菜单中选择"自动审查（Arbiter）"。';
export class AutoEntryRejected extends Error {
  constructor() {
    super(AUTO_REJECTION_HINT);
    this.name = 'AutoEntryRejected';
  }
}

/** One `/permission` command currently between `command/run` and `command/done`. */
interface PermissionCommand {
  readonly sessionId: string;
  readonly args: string;
}

/**
 * Session admission synchronisation and teardown.
 *
 * Two host constraints shape this module:
 *   - `session/event` observers run inside the host's commit, so an admission
 *     record cannot be written from the observer itself; every observer-path
 *     write is deferred to the next microtask.
 *   - `command/run` is committed before the `/permission` handler, so a
 *     same-value switch is visible; only `command/done` proves the switch
 *     happened, and a failed command leaves admission untouched.
 */
export class PermissionLifecycle {
  readonly admissions: SessionAdmissions;
  private readonly host: HostEnvironment;
  private readonly history: DecisionHistory;
  private readonly permissionCommands = new Map<string, PermissionCommand>();

  constructor(
    host: HostEnvironment,
    history: DecisionHistory,
    admissions: SessionAdmissions,
  ) {
    this.host = host;
    this.history = history;
    this.admissions = admissions;
  }

  register(): void {
    this.host.ctx.effect(() => () => this.unload(), 'arbiter runtime');
    this.host.ctx.on(
      'session/event',
      (
        session: TurnSessionLike,
        event: { readonly type?: string; readonly data?: unknown },
      ) => {
        this.onSessionEvent(session, event);
      },
    );
    this.registerAuto();
  }

  private sessionPermission(session: SessionLike): {
    sandbox: string | null;
    approval: string | null;
  } {
    let sandbox: string | null = null;
    let approval: string | null = null;
    if (typeof session.snapshotEvents !== 'function') {
      return { sandbox, approval };
    }
    for (const event of session.snapshotEvents()) {
      if (event.type === 'sandbox/mode' && isRecord(event.data)) {
        const mode = event.data['mode'];
        if (typeof mode === 'string') sandbox = mode;
      } else if (event.type === 'approval/policy' && isRecord(event.data)) {
        const policy = event.data['policy'];
        if (typeof policy === 'string') approval = policy;
      }
    }
    return { sandbox, approval };
  }

  /**
   * Roll one still-managed session back to workspace-write + ask.
   *
   * Three outcomes, because teardown must distinguish them: `unchanged` (the
   * session was never widened), `rolled` (the safe boundary is now committed)
   * and `failed` (the write did not land — the caller must fail closed for this
   * session instead of assuming the host will confine it).
   */
  rollbackSession(
    session: SessionLike,
    reason: string,
  ): 'unchanged' | 'rolled' | 'failed' {
    try {
      if (typeof session.append !== 'function') return 'failed';
      const current = this.sessionPermission(session);
      // A delegated child keeps the approval policy the host pinned at
      // delegation; only its captured sandbox is this plugin's to narrow.
      const delegated = session.header?.parentSession !== undefined;
      // An absent value is not "already narrow": the deployment default can be
      // full access, so a managed session states its safe boundary explicitly.
      const needsSandbox =
        current.sandbox !== 'workspace-write' &&
        current.sandbox !== 'read-only';
      const needsApproval = !delegated && current.approval !== 'ask';
      // Nothing this plugin widened: leave the log alone rather than writing a
      // no-op permission event into it.
      if (!needsSandbox && !needsApproval) return 'unchanged';
      if (needsSandbox)
        session.append('sandbox/mode', { mode: 'workspace-write' });
      if (needsApproval) session.append('approval/policy', { policy: 'ask' });
      this.host.ctx.logger.info(
        'arbiter: session %s rolled back to workspace-write + ask (%s)',
        session.id ?? 'unknown',
        reason,
      );
      return 'rolled';
    } catch (error) {
      this.host.ctx.logger.warn(
        'arbiter: session %s rollback failed: %s',
        session.id ?? 'unknown',
        error instanceof Error ? error.message : String(error),
      );
      return 'failed';
    }
  }

  /**
   * Retry the rollback for a session currently marked fail-closed.
   *
   * Returns true when the complete safe boundary is now confirmed; the mark is
   * cleared only then. A `null` session (a call without an agent) cannot be
   * recovered and keeps the refusal.
   */
  retryRollback(session: SessionLike | undefined): boolean {
    if (session === undefined) return false;
    // A refusal only promised a safe sandbox; a teardown promised the full exit.
    // `narrowSession` reports whether *both* knobs converged, which is the wrong
    // question for a refusal that deliberately preserved a stricter policy, so
    // the narrowing is attempted and the right predicate verifies it.
    const refusal = this.admissions.isRefusalMarked(session.id);
    const narrowed = this.admissions.narrowSession(session);
    if (!refusal && !narrowed) return false;
    const recovered = refusal
      ? refusalRecovered(session, this.admissions)
      : this.admissions.atSafeBoundary(session);
    if (!recovered) return false;
    if (session.id !== undefined)
      this.admissions.clearFailingClosed(session.id);
    return true;
  }

  onSessionEvent(
    session: TurnSessionLike,
    event: {
      readonly type?: string;
      readonly data?: unknown;
    },
  ): void {
    if (event.type === 'turn/start') {
      const id = session.id;
      if (id !== undefined) this.history.resetBreaker(id);
      return;
    }
    if (event.type === 'command/run' && isRecord(event.data)) {
      this.onCommandRun(session, event.data);
      return;
    }
    if (event.type === 'command/done' && isRecord(event.data)) {
      this.onCommandDone(event.data);
      return;
    }
    if (event.type === 'permission/preset' && typeof session.id === 'string') {
      // The host writes this inside a `/permission` handler, before the
      // command settles. An in-flight command owns the decision then, so only
      // a preset written with no command open is an independent switch (a
      // picker calling `presets.set()`); otherwise a failing command would
      // exit admission through this observer despite its own error.
      if (this.hasCommandInFlight(session.id)) return;
      this.scheduleExit(session.id, 'permission/preset');
    }
  }

  private onCommandRun(
    session: TurnSessionLike,
    data: Record<string, unknown>,
  ): void {
    const id = session.id;
    if (id === undefined || data['name'] !== 'permission') return;
    this.admissions.observe(session);
    const commandId = data['commandId'];
    if (typeof commandId !== 'string') return;
    this.permissionCommands.set(commandId, {
      sessionId: id,
      args: typeof data['args'] === 'string' ? data['args'] : '',
    });
  }

  private onCommandDone(data: Record<string, unknown>): void {
    const commandId = data['commandId'];
    if (typeof commandId !== 'string') return;
    const owner = this.permissionCommands.get(commandId);
    this.permissionCommands.delete(commandId);
    if (owner === undefined) return;
    if (
      data['kind'] === 'error' &&
      typeof data['text'] === 'string' &&
      data['text'].includes(AUTO_REJECTION_HINT)
    ) {
      // The native auto entry was rejected before any permission write; the
      // session keeps exactly the admission and knobs it had.
      this.host.runtime.autoRejections.push({
        at: Date.now(),
        sessionId: owner.sessionId,
      });
      return;
    }
    // A bare `/permission` only reports the current preset.
    if (owner.args.trim().length === 0) return;
    if (data['kind'] !== 'success') return;
    this.scheduleExit(owner.sessionId, 'permission-command');
  }

  /** Whether a `/permission` command for this session has not settled yet. */
  private hasCommandInFlight(sessionId: string): boolean {
    for (const command of this.permissionCommands.values()) {
      if (command.sessionId === sessionId) return true;
    }
    return false;
  }

  /**
   * Defer one admission exit out of the host commit.
   *
   * The observer cannot append: the host rejects a reentrant append while it
   * publishes this event. A microtask runs after the commit settled, and the
   * exit is skipped when the session is not enabled anyway (an initial preset
   * pin on a fresh session, a fork seed, a repeated command).
   */
  private scheduleExit(sessionId: string, reason: string): void {
    queueMicrotask(() => {
      try {
        const admission = this.admissions.admission(sessionId);
        // The fold can already show the exit (this microtask runs after the
        // commit), but descendants still hold the parent's captured sandbox
        // and must be settled even then.
        const settled = this.admissions.settleDescendants(sessionId);
        if (admission === null || !admission.enabled) {
          if (settled > 0) {
            this.host.lifecycle('admission/exit', {
              sessionId,
              reason,
              ok: true,
              settled,
            });
          }
          return;
        }
        const result = this.admissions.disable(sessionId, 'permission-command');
        this.host.lifecycle('admission/exit', {
          sessionId,
          reason,
          ok: result.ok,
          settled,
        });
        if (!result.ok) {
          this.host.ctx.logger.warn(
            'arbiter: session %s exit failed: %s',
            sessionId,
            result.message,
          );
        }
      } catch (error) {
        this.host.ctx.logger.warn(
          'arbiter: session %s exit failed: %s',
          sessionId,
          error instanceof Error ? error.message : String(error),
        );
      }
    });
  }

  /**
   * Publish the native Auto entry with a synchronous rejection gate.
   *
   * The same call is what proves who holds the host's single Auto slot: a
   * second registration throws, and the message is retained for coexistence.
   * Only a disposer that actually ran says `registered`; a throw says `other`.
   */
  private registerAuto(): void {
    const presets = this.host.services.presets;
    if (presets?.registerAuto === undefined) {
      this.host.runtime.autoSlot = 'unavailable';
      return;
    }
    try {
      this.host.ctx.effect(
        () =>
          presets.registerAuto?.(() => {
            // Outside the plugin's approval scope, leave the host's own auto
            // entry alone.
            if (!this.host.runtime.config.enabled) return;
            // A `/permission` command is being handled right now: this is a
            // user switch, so reject it before any preset or knob is written.
            if (this.permissionCommands.size > 0) {
              throw new AutoEntryRejected();
            }
            // No command is open: the host is publishing a stored `auto`
            // identity. Refusing here would roll the session load back.
            this.host.runtime.legacyAutoRestores.push({ at: Date.now() });
            this.host.ctx.logger.warn(
              'arbiter: session restored with a stored "auto" identity; the native auto entry stays rejected for new switches',
            );
          }),
        'arbiter preset',
      );
      // The effect ran its setup, so this plugin holds the slot now.
      this.host.runtime.autoSlot = 'registered';
    } catch (error) {
      // A second registration is a throw from the host, which is the only
      // public proof that someone else already owns the slot.
      this.host.runtime.autoSlot = 'other';
      this.host.runtime.autoPresetError =
        error instanceof Error ? error.message : String(error);
      this.host.ctx.logger.warn(
        'arbiter: auto preset registration failed: %s',
        this.host.runtime.autoPresetError,
      );
    }
  }

  /**
   * Bring every covered session back to a safe boundary before the drain.
   *
   * A session that already left keeps its own permission; every still-managed
   * one — main or inherited descendant — is narrowed, and one that cannot be
   * confirmed stays fail-closed so the gate keeps refusing it.
   */
  private rollBackCovered(
    covered: readonly (readonly [string, SessionLike])[],
  ): void {
    for (const [sessionId, session] of covered) {
      // Re-read the folded admission: a switch may have landed since the call
      // that covered this session.
      const admission = this.admissions.admission(sessionId);
      if (admission !== null && !admission.enabled) continue;
      // Retry a transient failure before giving up: a session left wide with
      // no gate is the one state teardown must not hand over.
      const rolled = this.admissions.narrowSession(session)
        ? this.rollbackSession(session, 'plugin-unload')
        : 'failed';
      // A successful sandbox write is not the whole target: a main session
      // also restores `ask`. Only both together let teardown stop protecting it.
      const safe = this.admissions.atSafeBoundary(session);
      if (rolled === 'failed' || !safe)
        this.admissions.markFailingClosed(sessionId);
      this.host.lifecycle('unload/rollback', {
        sessionId,
        outcome: rolled,
        failingClosed: rolled === 'failed' || !safe,
      });
    }
  }

  /** Roll back before draining: new ungated calls must see the narrowed sandbox. */
  private async unload(): Promise<void> {
    this.host.runtime.accepting = false;
    // A restored session can be live and admitted without this process having
    // gated a single call from it; teardown must still find it.
    const discovered = this.admissions.discover();
    // Covered includes sessions whose admission is inherited from an enabled
    // parent; those never gate their own record but still run under the
    // sandbox the host captured at delegation.
    const covered = this.admissions.teardownTargets();
    this.host.lifecycle('unload/stop-admission', {
      active: this.host.runtime.active,
      managed: covered.length,
      discovered,
    });
    this.rollBackCovered(covered);
    const rolledAt = Date.now();
    const started = Date.now();
    while (
      this.host.runtime.active > 0 &&
      Date.now() - started < UNLOAD_DRAIN_MS
    ) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    this.host.lifecycle('unload/drained', {
      active: this.host.runtime.active,
      waitedMs: Date.now() - started,
      rolledBeforeDrainMs: rolledAt - started,
    });
    if (this.host.runtime.active > 0) {
      this.host.ctx.logger.warn(
        'arbiter: unload drain window elapsed with %s call(s) still active',
        String(this.host.runtime.active),
      );
    }
    // One last attempt after the drain: the in-flight publish that caused the
    // failure may be finished now. This is the final moment at which this
    // plugin can still narrow the session.
    for (const sessionId of this.admissions.failingClosedSessions()) {
      const session = this.admissions
        .coveredSessions()
        .find(([id]) => id === sessionId)?.[1];
      if (session === undefined) continue;
      if (
        !this.admissions.narrowSession(session) ||
        !this.admissions.atSafeBoundary(session)
      ) {
        this.host.ctx.logger.error(
          'arbiter: session %s is still %s after unload: every narrowing write was refused by the host, so calls from it will not be gated and carry its previous permission. Select a permission again for that session.',
          sessionId,
          'wide',
        );
        continue;
      }
      this.admissions.clearFailingClosed(sessionId);
    }
    this.host.lifecycle('unload/release', {
      managed: this.admissions.coveredSessions().length,
      failingClosed: this.admissions.failingClosedSessions(),
    });
    this.host.runtime.instances -= 1;
    releaseRuntime(this.host.runtime);
  }
}
