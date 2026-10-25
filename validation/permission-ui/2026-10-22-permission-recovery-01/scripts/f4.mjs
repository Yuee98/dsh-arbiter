/**
 * F4: new calls submitted while a lifecycle action is draining.
 *
 * With a slow review in flight, the plugin is disabled through the real plugin
 * manager and new turns are submitted in the same wait window:
 *   - same session, after the disable;
 *   - a second session that never enabled arbiter.
 *
 * What matters is not only the final UI: whether a new call entered the gate,
 * when its body ran, under which sandbox, and what file effect it had.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionTimeline } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57801);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

// trusted boundary: the session starts at danger-full-access, so a call that
// escaped review after the gate vanished would be visible as an unreviewed
// write outside the workspace.
const host = await boot(caseDir, port, { mode: 'trusted' });
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/end' || e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const state = () => evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(async r => ({ status: r.status, body: r.ok ? await r.json() : null })).catch(e => ({ status: 0, error: String(e) }))`);
const openPluginPage = async () => {
  await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); b?.click(); return true; })()`);
  await waitFor(cdp, `[...document.querySelectorAll('button[role="switch"]')].some(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter'))`, 20000);
};
const toggleArbiter = () => evaluate(cdp, `(() => { const sw=[...document.querySelectorAll('button[role="switch"]')].find(b=>(b.getAttribute('aria-label')??'').includes('dsh-arbiter')); if(!sw) return {ok:false}; const before=sw.getAttribute('aria-checked'); sw.click(); return {ok:true,before}; })()`);
const back = async () => {
  await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 30000);
  await dismissOverlays(cdp);
  await sleep(600);
};
const marker = (p) => readFile(p, 'utf8').then((c) => c.trim()).catch(() => null);

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F4 bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('baseline-trusted', async () => {
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = { effective: effectivePermission(s.events), state: (await state()).body?.enabled };
    await writeFile(out('f4-01-baseline.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('drain-window-new-calls', async () => {
    // 1. start a call whose review stays pending
    await sendMessage(cdp, 'F4SLOW');
    for (let i = 0; i < 80; i += 1) {
      const log = await readFile(join(caseDir, 'reviewer-requests.jsonl'), 'utf8').catch(() => '');
      if (log.trim() !== '') break;
      await sleep(250);
    }
    const t0 = Date.now();

    // 2. disable through the real manager while the review is pending
    await openPluginPage();
    const clicked = await toggleArbiter();
    await sleep(400);
    const unmounted = await state();

    // 3. immediately submit a new turn in the same session
    await back();
    await sendMessage(cdp, 'F4NEW');
    const tNew = Date.now();
    await sleep(3000);

    // 4. and a second session that never enabled arbiter
    const opened = await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='新建会话'); b?.click(); return b !== undefined; })()`);
    await sleep(2000);
    await dismissOverlays(cdp);
    await sendMessage(cdp, 'F4SECOND');
    const tSecond = Date.now();
    await sleep(6000);

    const list = await sessions();
    const payload = {
      clicked, unmountedStatus: unmounted.status,
      timeline: { t0, tNew, tSecond },
      sessions: list.map((s) => ({
        sessionId: s.sessionId,
        effective: effectivePermission(s.events),
        timeline: permissionTimeline(s.events),
        results: s.events.filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 160) })),
        decisions: s.events.filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, ignorable: e.ignorable })),
      })),
      markers: {
        slowInside: await marker(join(host.handle.workspace, 'f4-slow.txt')),
        newOutside: await marker(join(host.handle.outside, 'f4-new.txt')),
        secondOutside: await marker(join(host.handle.outside, 'f4-second.txt')),
      },
      openedSecond: opened,
    };
    await writeFile(out('f4-02-drain.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f4-02-drain.png'));
    return payload;
  });

  await step('settle-and-reenable', async () => {
    await sleep(8000);
    await openPluginPage();
    const clicked = await toggleArbiter();
    await sleep(2500);
    const s = await state();
    const payload = { clicked, status: s.status, enabled: s.body?.enabled };
    await writeFile(out('f4-03-reenable.json'), JSON.stringify(payload, null, 2));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f4-final.png')).catch(() => {});
  await writeFile(out('f4-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length) console.log(JSON.stringify(failed, null, 2).slice(0, 2500));
}
