/**
 * T5 (lifecycle half): does a pending approval survive a real disable or
 * uninstall, and can it still be answered?
 *
 * For each action the driver records: the approval state before, the manager
 * action, whether the approval is still present afterwards, whether the tool
 * eventually ran, and the resulting permission.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 58681);
const action = process.argv[4] ?? 'disable';
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
const view = async (id) => (await sessions()).find((s) => s.sessionId === id);
const pending = (s) => (s?.events ?? []).some((e) => e.type === 'approval/asked')
  && !(s?.events ?? []).some((e) => e.type === 'approval/decided');
const approvals = (s) => (s?.events ?? []).filter((e) => e.type.startsWith('approval/'))
  .map((e) => ({ seq: e.seq, type: e.type, outcome: e.data?.outcome ?? null }));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'T5L bootstrap');
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
    return { pending: pending(s), effective: effectivePermission(s.events) };
  });

  await step('manager-action', async () => {
    await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); b?.click(); return true; })()`);
    await waitFor(cdp, `[...document.querySelectorAll('button[role="switch"]')].some(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter'))`, 20000);
    await sleep(800);

    if (action === 'disable') {
      const toggled = await evaluate(cdp, `(() => { const sw=[...document.querySelectorAll('button[role="switch"]')].find(b=>(b.getAttribute('aria-label')??'').includes('dsh-arbiter')); if(!sw) return {ok:false}; sw.click(); return {ok:true,before:sw.getAttribute('aria-checked')}; })()`);
      await sleep(3000);
      return { action, toggled };
    }
    // uninstall: open detail, then confirm in the dialog
    await evaluate(cdp, `(() => { const row=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??'')==='查看 dsh-arbiter'); row?.click(); return true; })()`);
    await sleep(1500);
    const clicked = await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='卸载 dsh-arbiter'); if(!b) return false; b.click(); return true; })()`);
    await sleep(900);
    const confirmed = await evaluate(cdp, `(() => {
      const dialogs=[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
      const scope=dialogs.at(-1) ?? document;
      const hit=[...scope.querySelectorAll('button')].find(b=>(b.innerText??'').trim()==='卸载');
      if(!hit) return false; hit.click(); return true;
    })()`);
    await sleep(6000);
    return { action, clicked, confirmed };
  });

  await step('approval-after-action', async () => {
    const s = await view(sessionId);
    const payload = {
      action,
      pending: pending(s),
      approvals: approvals(s),
      effective: effectivePermission(s?.events ?? []),
      results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 200) })),
      marker: await readFile(join(host.handle.workspace, 't5-ask.txt'), 'utf8').catch(() => null),
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-400),
    };
    await writeFile(out(`t5l-01-${action}.json`), JSON.stringify(payload, null, 2));
    await shot(cdp, out(`t5l-01-${action}.png`));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await writeFile(out('t5l-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
}
