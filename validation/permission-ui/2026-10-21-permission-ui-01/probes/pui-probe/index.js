/**
 * Validation probe (host half) for the proposed arbiter permission-UI seams.
 *
 * This is a FIXTURE, not product code. It exercises only public APIs:
 *
 *  - `appendPluginRecord` / `pluginRecordOf` (dsh-session) as the durable,
 *    ignorable per-session enablement record — deliberately independent of the
 *    audit SQLite database
 *  - `session/created` + `snapshotEvents` for cold restore
 *  - a session projection with a wire view for client-visible state
 *  - `tools/pre-execute` for the gate, plus a controllable review delay
 *  - `approval.request` with a held answerer for the manual path
 *  - `command/run` observation for `/permission` exit intent (same value included)
 *  - `ctx.effect` async disposer for the unload drain/rollback order
 *  - exact Fetch routes (`connection.fetch.register`) for the driver
 */
import { mkdirSync, appendFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

export const name = 'pui-probe';
export const inject = ['tools', 'sessions', 'connection', 'sessionProjections'];

const ROUTE = '/api/pui';
const ENABLED = 'plugin:pui/enabled';
const DISABLED = 'plugin:pui/disabled';

/** Resolve a shipped package through the running CLI's installation root. */
function harnessRoot() {
  const marker = '/node_modules/@deepseek-ai/dsh-desktop-host/';
  const cli = process.argv.find((arg) => arg.includes(marker));
  if (cli !== undefined) return cli.slice(0, cli.indexOf(marker));
  return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh';
}
const sessionApi = await import(`file://${harnessRoot()}/node_modules/@deepseek-ai/dsh-session/lib/index.js`);
const { appendPluginRecord, pluginRecordOf } = sessionApi;

export function apply(ctx, config) {
  const home = process.env.DSH_HOME ?? process.cwd();
  const logPath = config.logPath ?? join(home, 'pui', 'events.jsonl');
  mkdirSync(dirname(logPath), { recursive: true });

  const active = new Set();
  const t0 = Date.now();
  const log = (event, data = {}) => {
    try { appendFileSync(logPath, JSON.stringify({ at: Date.now(), t: Date.now() - t0, event, ...data }) + '\n'); } catch {}
  };
  log('probe/start', { logPath, pid: process.pid });

  /** Fold the durable log. Only ignorable plugin records count as enablement. */
  function fold(session) {
    let enabled = false, boundary = null, reason = null, origin = null, revision = 0;
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : [];
    for (const event of events) {
      const rec = typeof pluginRecordOf === 'function' ? pluginRecordOf(event) : undefined;
      if (rec === undefined) continue;
      if (rec.type === ENABLED) {
        enabled = true; boundary = rec.data?.boundary ?? 'guarded'; origin = rec.data?.origin ?? null; revision += 1;
      } else if (rec.type === DISABLED) {
        enabled = false; reason = rec.data?.reason ?? null; revision += 1;
      }
    }
    return { sessionId: session.id, enabled, boundary, reason, origin, revision };
  }

  const cache = new Map();
  const read = (session) => {
    const hit = cache.get(session.id);
    if (hit !== undefined && hit.seq === session.seq) return hit.value;
    const value = fold(session);
    cache.set(session.id, { seq: session.seq, value });
    return value;
  };
  const liveSessions = () => [...(ctx.get('sessions')?.list?.() ?? [])];
  const status = (sessionId) => {
    const session = ctx.get('sessions')?.get?.(sessionId);
    return session === undefined ? { sessionId, known: false, enabled: false } : { known: true, ...read(session) };
  };

  function record(session, type, data) {
    if (typeof appendPluginRecord !== 'function') throw new Error('appendPluginRecord unavailable');
    appendPluginRecord(session, type, data);
  }

  function enable(session, boundary, origin) {
    record(session, ENABLED, { boundary, origin, at: Date.now() });
    session.append('sandbox/mode', { mode: boundary === 'trusted' ? 'danger-full-access' : 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    log('pui/enabled', { sessionId: session.id, boundary, origin, seq: session.seq });
    return read(session);
  }

  function disable(session, reason, mode) {
    const before = read(session);
    if (!before.enabled) return { changed: false, status: before };
    record(session, DISABLED, { reason, at: Date.now() });
    if (mode !== undefined) session.append('sandbox/mode', { mode });
    log('pui/disabled', { sessionId: session.id, reason, mode: mode ?? null });
    return { changed: true, status: read(session) };
  }

  ctx.sessionProjections.register({
    key: 'puiPermission',
    stateVersion: 1,
    stateSchema: { parse: (value) => value },
    init: () => ({ enabled: false, boundary: null, revision: 0 }),
    apply: (state, event) => {
      const rec = typeof pluginRecordOf === 'function' ? pluginRecordOf(event) : undefined;
      if (rec === undefined) return state;
      if (rec.type === ENABLED) return { enabled: true, boundary: rec.data?.boundary ?? 'guarded', revision: state.revision + 1 };
      if (rec.type === DISABLED) return { enabled: false, boundary: state.boundary, revision: state.revision + 1 };
      return state;
    },
    wire: {
      viewSchema: { parse: (value) => value },
      view: (state) => ({ enabled: state.enabled, boundary: state.boundary, revision: state.revision }),
    },
  });

  // Cold restore: a stored enabled session re-asserts its boundary on load.
  ctx.on('session/created', (session) => {
    const recordValue = read(session);
    log('session/created', { sessionId: session.id, seq: session.seq, record: recordValue });
    if (!recordValue.enabled) return;
    session.append('sandbox/mode', { mode: recordValue.boundary === 'trusted' ? 'danger-full-access' : 'workspace-write' });
    session.append('approval/policy', { policy: 'ask' });
    log('pui/restored', { sessionId: session.id, boundary: recordValue.boundary, seq: session.seq });
  });

  // Observation + same-value exit intent.
  ctx.on('session/event', (session, event) => {
    if (['command/run', 'command/done', 'permission/preset', 'sandbox/mode', 'approval/policy', ENABLED, DISABLED].includes(event.type)) {
      log('session/event', { sessionId: session.id, seq: event.seq, type: event.type, data: event.data, enabled: read(session).enabled });
    }
    if (event.type !== 'command/run' || event.data?.name !== 'permission') return;
    const target = String(event.data.args ?? '').trim().split(/\s+/u)[0] ?? '';
    if (!['workspace-write', 'read-only', 'danger-full-access', 'auto'].includes(target)) return;
    if (!read(session).enabled) return;
    log('pui/command-exit', { sessionId: session.id, target, nativeValueMayBeUnchanged: true });
    // A session/event observer runs inside the host's commit; an append there
    // is rejected as re-entrant, so the exit is applied on the next tick.
    queueMicrotask(() => {
      try {
        const result = disable(session, 'permission-command', undefined);
        log('pui/command-exit-applied', { sessionId: session.id, target, changed: result.changed });
      } catch (error) {
        log('pui/command-exit-failed', { sessionId: session.id, target, message: String(error?.message ?? error) });
      }
    });
  });

  /** Controllable delay, cancelled by the host's own exec signal. */
  const waitFor = (ms, signal) => new Promise((resolve) => {
    if (signal?.aborted) return resolve('cancelled');
    const timer = setTimeout(() => { cleanup(); resolve('done'); }, ms);
    const onAbort = () => { cleanup(); resolve('cancelled'); };
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', onAbort); };
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  ctx.on('tools/pre-execute', async (exec, next) => {
    const session = exec.agent?.session;
    if (session === undefined) return next();
    const recordValue = read(session);
    if (!recordValue.enabled) return next();
    const text = JSON.stringify(exec.arguments ?? {});
    const callId = exec.callId;
    active.add(callId);
    log('gate/call', { sessionId: session.id, tool: exec.name, callId, boundary: recordValue.boundary, text: text.slice(0, 400) });
    try {
      if (text.includes('PUI-DENY')) {
        log('gate/deny', { sessionId: session.id, tool: exec.name, callId });
        return { kind: 'deny', reason: 'pui probe: deterministic deny marker' };
      }
      const slow = /PUI-SLOW-(\d+)/u.exec(text);
      if (slow !== null) {
        log('review/inflight', { sessionId: session.id, callId, delayMs: Number(slow[1]) });
        const outcome = await waitFor(Number(slow[1]), exec.signal);
        log('review/settled', { sessionId: session.id, callId, outcome, signalAborted: exec.signal?.aborted === true });
        if (outcome === 'cancelled') return { kind: 'cancel' };
      }
      if (text.includes('PUI-ASK')) {
        const approval = ctx.get('approval');
        log('approval/opening', { sessionId: session.id, callId });
        let outcome = 'unavailable';
        try {
          outcome = await approval.request({
            agent: exec.agent, toolName: exec.name, callId,
            reason: 'pui probe: manual approval probe', signal: exec.signal,
          });
        } catch (error) {
          log('approval/threw', { sessionId: session.id, callId, message: String(error?.message ?? error) });
        }
        log('approval/outcome', { sessionId: session.id, callId, outcome, signalAborted: exec.signal?.aborted === true });
        if (outcome !== 'allowed-once') return { kind: 'deny', reason: `pui probe: approval ${outcome}` };
      }
      log('gate/allow', { sessionId: session.id, tool: exec.name, callId });
      return { kind: 'allow' };
    } finally {
      active.delete(callId);
      log('gate/released', { sessionId: session.id, callId, active: active.size });
    }
  });

  // Held answerer: an approval that stays pending until the host aborts it.
  if (config.holdApprovals === true) {
    ctx.on('approval/request', async (req) => {
      log('approval/answerer-arrived', { callId: req?.callId, reason: req?.reason });
      const outcome = await waitFor(Number(config.holdMs ?? 600000), req?.signal);
      log('approval/answerer-settled', { callId: req?.callId, outcome, signalAborted: req?.signal?.aborted === true });
      return outcome === 'cancelled' ? 'cancelled' : 'allowed-once';
    }, { prepend: true });
  }

  // The product's unload sequence: stop taking new work, drain in-flight work,
  // roll back only sessions still managed here, then release.
  ctx.effect(() => async () => {
    const started = Date.now();
    const drainMs = Number(config.drainMs ?? 0);
    log('pui/dispose-begin', { active: [...active], drainMs });
    while (active.size > 0 && Date.now() - started < drainMs) {
      log('pui/dispose-wait', { active: [...active], waitedMs: Date.now() - started });
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    log('pui/dispose-drained', { active: [...active], waitedMs: Date.now() - started });
    for (const session of liveSessions()) {
      const current = read(session);
      if (!current.enabled) { log('pui/dispose-skip', { sessionId: session.id, reason: 'not-managed' }); continue; }
      try {
        session.append('sandbox/mode', { mode: 'workspace-write' });
        session.append('approval/policy', { policy: 'ask' });
        record(session, DISABLED, { reason: 'plugin-unload', at: Date.now() });
        log('pui/dispose-rollback', { sessionId: session.id, to: 'workspace-write+ask', boundaryWas: current.boundary });
      } catch (error) {
        log('pui/dispose-rollback-failed', { sessionId: session.id, message: String(error?.message ?? error) });
      }
    }
    log('pui/dispose-end', { waitedMs: Date.now() - started });
  }, 'pui unload drain/rollback');

  function json(value, statusCode = 200) {
    return new Response(JSON.stringify(value), { status: statusCode, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } });
  }
  const body = async (request) => {
    const text = await request.text();
    return text.trim() === '' ? {} : JSON.parse(text);
  };

  ctx.inject(['connection'], (child) => {
    const routes = [
      { path: `${ROUTE}/events`, methods: ['GET'], requestBody: 'buffered', fetch: async () => {
        const { readFileSync } = await import('node:fs');
        let lines = [];
        try { lines = readFileSync(logPath, 'utf8').split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l)); } catch {}
        return json({ ok: true, events: lines });
      } },
      { path: `${ROUTE}/state`, methods: ['GET'], requestBody: 'buffered', fetch: async () => json({ ok: true, sessions: Object.fromEntries(liveSessions().map((s) => [s.id, read(s)])) }) },
      { path: `${ROUTE}/status`, methods: ['GET'], requestBody: 'buffered', fetch: async (request) => json({ ok: true, status: status(new URL(request.url).searchParams.get('sessionId') ?? ''), live: liveSessions().map((s) => s.id) }) },
      { path: `${ROUTE}/session-events`, methods: ['GET'], requestBody: 'buffered', fetch: async (request) => {
        const session = ctx.get('sessions')?.get?.(new URL(request.url).searchParams.get('sessionId') ?? '');
        if (session === undefined) return json({ ok: false, code: 'no-session' }, 409);
        return json({ ok: true, seq: session.seq, events: session.snapshotEvents().filter((e) => e.type !== 'session/end-seed').map((e) => ({ seq: e.seq, type: e.type, data: e.data ?? null, ignorable: e.ignorable === true })) });
      } },
      { path: `${ROUTE}/active`, methods: ['GET'], requestBody: 'buffered', fetch: async () => json({ ok: true, active: [...active] }) },
      { path: `${ROUTE}/enable`, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
        const { sessionId, boundary, origin } = await body(request);
        const session = ctx.get('sessions')?.get?.(sessionId);
        if (session === undefined) return json({ ok: false, code: 'no-session' }, 409);
        if (boundary !== 'trusted' && boundary !== 'guarded') return json({ ok: false, code: 'bad-boundary' }, 400);
        return json({ ok: true, status: enable(session, boundary, origin ?? 'route') });
      } },
      { path: `${ROUTE}/disable`, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
        const { sessionId, reason, mode } = await body(request);
        const session = ctx.get('sessions')?.get?.(sessionId);
        if (session === undefined) return json({ ok: false, code: 'no-session' }, 409);
        return json({ ok: true, result: disable(session, reason ?? 'route', mode) });
      } },
      { path: `${ROUTE}/host`, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
        const { sessionId, op } = await body(request);
        const session = ctx.get('sessions')?.get?.(sessionId);
        if (session === undefined) return json({ ok: false, code: 'no-session' }, 409);
        if (op === 'current') return json({ ok: true, current: ctx.get('permissionPresets')?.current?.(session) ?? null });
        return json({ ok: false, code: 'bad-op' }, 400);
      } },
      { path: `${ROUTE}/sandbox`, methods: ['GET'], requestBody: 'buffered', fetch: async (request) => {
        const session = ctx.get('sessions')?.get?.(new URL(request.url).searchParams.get('sessionId') ?? '');
        if (session === undefined) return json({ ok: false, code: 'no-session' }, 409);
        const policy = ctx.get('sandboxPolicy');
        return json({ ok: true, effectiveMode: policy?.resolve?.(session)?.mode ?? policy?.modeOf?.(session) ?? null, approval: ctx.get('approval')?.effectivePolicy?.(session) ?? null });
      } },
      { path: `${ROUTE}/resume`, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
        const { sessionId } = await body(request);
        const agents = ctx.get('agents');
        if (agents?.resume === undefined) return json({ ok: false, code: 'no-agents' }, 409);
        try {
          const handle = await agents.resume({ resumeSessionId: sessionId });
          const session = handle?.agent?.session;
          log('pui/resumed', { sessionId, seq: session?.seq ?? null, enabled: session === undefined ? null : read(session).enabled });
          return json({ ok: true, seq: session?.seq ?? null, status: session === undefined ? null : read(session) });
        } catch (error) {
          log('pui/resume-failed', { sessionId, message: String(error?.message ?? error) });
          return json({ ok: false, code: 'resume-failed', message: String(error?.message ?? error) }, 409);
        }
      } },
      { path: `${ROUTE}/unload`, methods: ['POST'], requestBody: 'buffered', fetch: async (request) => {
        const { drainMs } = await body(request);
        config.drainMs = Number(drainMs ?? config.drainMs ?? 0);
        log('pui/unload-requested', { drainMs: config.drainMs, active: [...active] });
        setTimeout(() => {
          log('pui/unload-disposing', { active: [...active] });
          try {
            Promise.resolve(ctx.fiber.dispose()).then(
              () => log('pui/unload-disposed'),
              (error) => log('pui/unload-dispose-failed', { message: String(error?.message ?? error) }),
            );
          } catch (error) {
            log('pui/unload-failed', { message: String(error?.message ?? error) });
          }
        }, 50);
        return json({ ok: true, drainMs: config.drainMs, active: active.size });
      } },
    ];
    child.effect(() => {
      const disposers = routes.map((route) => child.connection.fetch.register(route));
      return () => { for (const disposer of disposers) disposer(); };
    }, 'pui routes');
  });

  log('probe/ready', { holdApprovals: config.holdApprovals === true, registerAuto: config.registerAuto === true });
}
