/**
 * F2 (trusted scope): the same `/permission auto` refusal in a deployment whose
 * default sandbox is danger-full-access, i.e. the arbiter "trusted" boundary.
 *
 * The point is that refusal cannot be inferred from the preset name: in trusted
 * the effective bundle already equals the auto bundle, so a naive
 * "no value change means nothing happened" check would miss the user's intent.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, permissionTimeline, effectivePermission, permissionCommands } from './session-log.mjs';
import { sendMessage, submitCommand, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57691);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, { mode: 'trusted' });
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 40000);
await dismissOverlays(cdp);

const list = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/end' || e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const view = async () => (await list()).map((s) => ({
  sessionId: s.sessionId,
  effective: effectivePermission(s.events),
  timeline: permissionTimeline(s.events),
  commands: permissionCommands(s.events),
}));
const commands = async () => (await list()).flatMap((s) => permissionCommands(s.events).map((c) => ({ ...c, sessionId: s.sessionId })));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F2 trusted bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await list()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('auto-rejected-trusted', async () => {
    const before = (await view()).find((s) => s.sessionId === sessionId);
    const submission = await submitCommand(cdp, '/permission auto', commands);
    await sleep(1500);
    const after = (await view()).find((s) => s.sessionId === sessionId);
    const s = await evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(r => r.json())`);
    const payload = {
      submission,
      before: before?.effective,
      after: after?.effective,
      newEvents: after?.timeline.slice(before?.timeline.length ?? 0) ?? [],
      autoEntry: s.autoEntry,
    };
    await writeFile(out('f2-trusted-01.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f2-trusted-01.png'));
    return payload;
  });

  await step('same-value-trusted', async () => {
    // In trusted the host value is danger-full-access; re-selecting it must
    // still succeed as a plain preset command (it is not the auto entry).
    const before = (await view()).find((s) => s.sessionId === sessionId);
    const submission = await submitCommand(cdp, '/permission danger-full-access', commands);
    await sleep(1200);
    const after = (await view()).find((s) => s.sessionId === sessionId);
    const payload = { submission, before: before?.effective, after: after?.effective };
    await writeFile(out('f2-trusted-02.json'), JSON.stringify(payload, null, 2));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f2-trusted-final.png')).catch(() => {});
  await writeFile(out('f2-trusted-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
}
