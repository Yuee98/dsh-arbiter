import type { SessionLike } from '../snapshot.js';
import type { HostEnvironment, TurnSessionLike } from './types.js';
import type { DecisionHistory } from './history.js';
import { isRecord } from './common.js';
import { releaseRuntime } from './runtime.js';

export const UNLOAD_DRAIN_MS = 30_000;
export const AUTO_REJECTION_HINT =
  '此入口不受 Arbiter 支持。请在会话权限菜单中选择"自动审查（Arbiter）"。';
export class AutoEntryRejected extends Error {
  constructor() {
    super(AUTO_REJECTION_HINT);
    this.name = 'AutoEntryRejected';
  }
}
const permissionCommandsInFlight = new Map<string, string>();

/** Tracks sessions this instance actually gates; user switches remove ownership. */
export class PermissionLifecycle {
  readonly managed = new Map<string, SessionLike>();
  private readonly host: HostEnvironment;
  private readonly history: DecisionHistory;
  constructor(host: HostEnvironment, history: DecisionHistory) {
    this.host = host;
    this.history = history;
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

  /** Roll one still-managed session back to workspace-write + ask. */
  rollbackSession(session: SessionLike, reason: string): boolean {
    try {
      if (typeof session.append !== 'function') return false;
      const current = this.sessionPermission(session);
      const needsSandbox =
        current.sandbox !== null && current.sandbox !== 'workspace-write';
      const needsApproval =
        current.approval !== null && current.approval !== 'ask';
      // Nothing this plugin widened: leave the log alone rather than writing a
      // no-op permission event into it.
      if (!needsSandbox && !needsApproval) return false;
      if (needsSandbox)
        session.append('sandbox/mode', { mode: 'workspace-write' });
      if (needsApproval) session.append('approval/policy', { policy: 'ask' });
      this.host.ctx.logger.info(
        'arbiter: session %s rolled back to workspace-write + ask (%s)',
        session.id ?? 'unknown',
        reason,
      );
      return true;
    } catch (error) {
      this.host.ctx.logger.warn(
        'arbiter: session %s rollback failed: %s',
        session.id ?? 'unknown',
        error instanceof Error ? error.message : String(error),
      );
      return false;
    }
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
    }
    if (
      event.type === 'permission/preset' &&
      isRecord(event.data) &&
      typeof session.id === 'string'
    ) {
      // The user chose a host preset: this session is no longer managed, so
      // an unload must leave the chosen permission alone.
      this.managed.delete(session.id);
    }
    if (
      event.type === 'command/run' &&
      isRecord(event.data) &&
      event.data['name'] === 'permission'
    ) {
      const commandId = event.data['commandId'];
      if (typeof commandId === 'string') {
        permissionCommandsInFlight.set(commandId, session.id ?? 'unknown');
      }
      return;
    }
    if (event.type === 'command/done' && isRecord(event.data)) {
      this.onCommandDone(event.data);
    }
  }

  private onCommandDone(data: Record<string, unknown>): void {
    const commandId = data['commandId'];
    if (typeof commandId === 'string') {
      const owner = permissionCommandsInFlight.get(commandId);
      permissionCommandsInFlight.delete(commandId);
      // A failed `/permission auto` never exited arbiter: report it and
      // leave the session state exactly as it was.
      if (
        owner !== undefined &&
        data['kind'] === 'error' &&
        typeof data['text'] === 'string' &&
        data['text'].includes(AUTO_REJECTION_HINT)
      ) {
        this.host.runtime.autoRejections.push({
          at: Date.now(),
          sessionId: owner,
        });
      }
    }
  }

  private registerAuto(): void {
    if (this.host.services.presets?.registerAuto !== undefined) {
      try {
        this.host.ctx.effect(
          () =>
            this.host.services.presets?.registerAuto?.(() => {
              // Outside the plugin's approval scope, leave the host's own auto
              // entry alone.
              if (!this.host.runtime.config.enabled) return;
              // A `/permission` command is being handled right now: this is a
              // user switch, so reject it before any preset or knob is written.
              if (permissionCommandsInFlight.size > 0) {
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
      } catch (error) {
        this.host.runtime.autoPresetError =
          error instanceof Error ? error.message : String(error);
        this.host.ctx.logger.warn(
          'arbiter: auto preset registration failed: %s',
          this.host.runtime.autoPresetError,
        );
      }
    }
  }
  /** Roll back before draining: new ungated calls must see the narrowed sandbox. */
  private async unload(): Promise<void> {
    this.host.runtime.accepting = false;
    this.host.lifecycle('unload/stop-admission', {
      active: this.host.runtime.active,
      managed: this.managed.size,
    });
    for (const [sessionId, session] of this.managed) {
      // Re-check: a permission switch may have landed before this point.
      if (!this.managed.has(sessionId)) continue;
      const rolled = this.rollbackSession(session, 'plugin-unload');
      this.host.lifecycle('unload/rollback', { sessionId, changed: rolled });
      this.managed.delete(sessionId);
    }
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
    this.host.lifecycle('unload/release', { managed: this.managed.size });
    this.host.runtime.instances -= 1;
    releaseRuntime(this.host.runtime);
  }
}
