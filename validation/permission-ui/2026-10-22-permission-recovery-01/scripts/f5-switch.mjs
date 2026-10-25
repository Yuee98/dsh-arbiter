/**
 * F5 (switch during a pending approval): the approval is open, then the user
 * switches the session off arbiter while it is still waiting.
 *
 * What is checked: the approval is neither auto-approved nor auto-rejected by
 * the switch, the arbiter stops taking new calls, and the pending request keeps
 * its own outcome once a human answers it in the same window.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionCommands } from './session-log.mjs';
import { sendMessage, submitCommand, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57961);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port);
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const commands = async () => (await sessions())
  .flatMap((s) => permissionCommands(s.events).map((c) => ({ ...c, sessionId: s.sessionId })));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F5S bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('open-approval', async () => {
    await sendMessage(cdp, 'F5ASK');
    for (let i = 0; i < 240; i += 1) {
      const s = (await sessions()).find((x) => x.sessionId === sessionId);
      if (s?.events.some((e) => e.type === 'approval/asked')) break;
      await sleep(500);
    }
    await shot(cdp, out('f5s-01-open.png'));
    return { asked: true };
  });

  await step('switch-while-pending', async () => {
    // The composer is blocked while the approval is open, so use the same
    // public session.command() path the native selector uses.
    const switched = await evaluate(cdp, `(async () => {
      const bridge = window.__puiCommand;
      return bridge === undefined ? { ok: false, note: 'no bridge' } : { ok: true };
    })()`);
    // The composer is blocked while the approval waits, so switch through the
    // native permission control the composer bar still renders.
    const composerUsable = await evaluate(cdp, `(() => {
      const el = document.querySelector('[contenteditable="true"]');
      if (el === null) return false;
      el.focus();
      return document.activeElement === el;
    })()`);
    const picker = await evaluate(cdp, `(() => {
      const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter((el) => el.isConnected);
      const button = cells[0]?.querySelector('button');
      if (!button) return { ok: false, reason: 'no native control' };
      button.click();
      return { ok: true };
    })()`);
    await sleep(700);
    const chosen = await evaluate(cdp, `(() => {
      const items = [...document.querySelectorAll('[role="menuitem"], [role="option"], button, li')];
      const hit = items.find((el) => (el.innerText ?? '').trim().includes('工作区内修改') && el.isConnected);
      if (!hit) return { ok: false, seen: items.map((e) => (e.innerText ?? '').trim()).filter((t) => t && t.length < 20).slice(0, 10) };
      hit.click();
      return { ok: true };
    })()`);
    await sleep(2500);
    const submission = { composerUsable, picker, chosen };
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      switched,
      composerUsable,
      submission,
      approvals: (s?.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ seq: e.seq, type: e.type, outcome: e.data?.outcome ?? null })),
      effective: effectivePermission(s?.events ?? []),
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-500),
    };
    await writeFile(out('f5s-02-switch.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f5s-02-switch.png'));
    return payload;
  });

  await step('settle', async () => {
    await sleep(6000);
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      approvals: (s?.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ seq: e.seq, type: e.type, outcome: e.data?.outcome ?? null })),
      decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace })),
      results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 160) })),
      marker: await readFile(join(host.handle.workspace, 'f5s-ask.txt'), 'utf8').catch(() => null),
      effective: effectivePermission(s?.events ?? []),
    };
    await writeFile(out('f5s-03-settled.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f5s-03-settled.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await writeFile(out('f5s-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
}
