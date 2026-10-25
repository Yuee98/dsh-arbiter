/**
 * T5: switching while a real approval is pending.
 *
 * Three separate entry points, each recorded with its own pre-state, actual
 * arguments, return/error, and the resulting command/permission events:
 *
 *   A. the native control's own path, invoked as the client does:
 *      `sessions.binding(id).session.command('/permission read-only')`
 *      — a preset DIFFERENT from the current one.
 *   B. an explicit same-value `/permission workspace-write`, which is the
 *      documented way a user "leaves" arbiter without changing permission.
 *
 * Every attempt is made while `approval/asked` is present and unanswered.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionCommands } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 58181);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, { bridge: true });
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);
const bridgeReady = await waitFor(cdp, `typeof window.__dshCommand === 'object'`, 30000);
if (bridgeReady !== true) {
  const diag = await evaluate(cdp, `(() => ({ handle: typeof window.__dshCommand, loader: typeof window.__ModuleLoader__, keys: Object.keys(window).filter(k=>k.startsWith('__')).slice(0,10) }))()`);
  throw new Error('command bridge not installed: ' + JSON.stringify(diag));
}

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const view = async (id) => (await sessions()).find((s) => s.sessionId === id);
const approvals = (s) => (s?.events ?? []).filter((e) => e.type.startsWith('approval/'));
const pending = (s) => approvals(s).some((e) => e.type === 'approval/asked') && !approvals(s).some((e) => e.type === 'approval/decided');
const bridge = async (sessionId, text) => {
  // The handle can be dropped by a client reload; wait for it again rather
  // than reporting a false "rejected".
  await waitFor(cdp, `typeof window.__dshCommand === 'object'`, 20000);
  return evaluate(cdp, `window.__dshCommand.call(${JSON.stringify(sessionId)}, ${JSON.stringify(text)})`);
};
const commandEvents = (s) => (s?.events ?? []).filter((e) => e.type === 'command/run' || e.type === 'command/done')
  .map((e) => ({ seq: e.seq, type: e.type, name: e.data?.name, args: e.data?.args, kind: e.data?.kind, text: e.data?.text }));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'T5 bootstrap');
    for (let i = 0; i < 150; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('open-approval', async () => {
    await sendMessage(cdp, 'T5ASK');
    for (let i = 0; i < 240; i += 1) {
      if (pending(await view(sessionId))) break;
      await sleep(500);
    }
    const s = await view(sessionId);
    const payload = {
      pending: pending(s),
      effective: effectivePermission(s.events),
      approvals: approvals(s).map((e) => ({ type: e.type, data: e.data })),
    };
    await writeFile(out('t5-01-pending.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('t5-01-pending.png'));
    return payload;
  });

  await step('A-native-different-preset', async () => {
    const before = await view(sessionId);
    const result = await bridge(sessionId, '/permission read-only');
    await sleep(2500);
    const after = await view(sessionId);
    const payload = {
      entry: 'sessions.binding(id).session.command("/permission read-only")',
      before: { effective: effectivePermission(before.events), pending: pending(before) },
      result,
      after: { effective: effectivePermission(after.events), pending: pending(after) },
      approvals: approvals(after).map((e) => ({ type: e.type, outcome: e.data?.outcome ?? null })),
      commands: commandEvents(after).slice(-4),
    };
    await writeFile(out('t5-02-different-preset.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('t5-02-different-preset.png'));
    return payload;
  });

  await step('B-same-value-explicit', async () => {
    const before = await view(sessionId);
    const result = await bridge(sessionId, '/permission workspace-write');
    await sleep(2500);
    const after = await view(sessionId);
    const payload = {
      entry: 'sessions.binding(id).session.command("/permission workspace-write")',
      before: { effective: effectivePermission(before.events), pending: pending(before) },
      result,
      after: { effective: effectivePermission(after.events), pending: pending(after) },
      approvals: approvals(after).map((e) => ({ type: e.type, outcome: e.data?.outcome ?? null })),
      commands: commandEvents(after).slice(-4),
    };
    await writeFile(out('t5-03-same-value.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('C-answer-after-attempts', async () => {
    // The approval that has been pending throughout must still be answerable.
    // A human answers it in this window; the driver only observes.
    await shot(cdp, out('t5-04-still-pending.png'));
    const s = await view(sessionId);
    const payload = {
      stillPending: pending(s),
      approvals: approvals(s).map((e) => ({ type: e.type, outcome: e.data?.outcome ?? null })),
      effective: effectivePermission(s.events),
      note: 'left pending for a human answer; see t5h for the answered variant',
    };
    await writeFile(out('t5-05-still-pending.json'), JSON.stringify(payload, null, 2));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('t5-final.png')).catch(() => {});
  await writeFile(out('t5-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const f = steps.filter((s) => s.ok === false);
  if (f.length) console.log(JSON.stringify(f, null, 2).slice(0, 1500));
}
