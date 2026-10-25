/**
 * F3: real plugin-manager disable (and re-enable) of the actual plugin.
 *
 * The switch is the Web plugin page's own `启用 dsh-arbiter` control
 * (role="switch"), which calls `pluginManager.setPluginEnabled(entryId, …)`.
 * Nothing here uses a probe route or `ctx.fiber.dispose()`.
 *
 * Two in-flight shapes are covered:
 *   A. a slow allow review is running when the switch goes off;
 *   B. the review finishes and the call needs a human, then the switch goes off.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionTimeline } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57761);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, {
  rules: [{ id: 'f3-allow', match: { node: 'command', kind: 'regex', pattern: '^printf' }, verdict: 'allow' }],
});
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/end' || e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));

/** Return from the plugin page to the conversation view. */
const backToConversation = async () => {
  await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 30000);
  await dismissOverlays(cdp);
  await sleep(800);
};

const openPluginPage = async () => {
  await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); if(!b) return false; b.click(); return true; })()`);
  await waitFor(cdp, `[...document.querySelectorAll('button[role="switch"]')].some(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter'))`, 20000);
};
const toggle = () => evaluate(cdp, `(() => {
  const sw=[...document.querySelectorAll('button[role="switch"]')].find(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter'));
  if (!sw) return { ok:false, error:'switch not found' };
  const state = sw.getAttribute('aria-checked');
  sw.click();
  return { ok:true, before: state };
})()`);
const waitToggle = (state) => waitFor(cdp, `(() => { const sw=[...document.querySelectorAll('button[role="switch"]')].find(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter')); return sw !== undefined && sw.getAttribute('aria-checked') === ${JSON.stringify(state)}; })()`, 30000);

const arbiterState = async () => {
  // After disable the route is gone; treat a failed fetch as "unmounted".
  return evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(async r => ({ status: r.status, body: r.ok ? await r.json() : (await r.text()).slice(0,80) })).catch(e => ({ status: 0, error: String(e) }))`);
};

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F3 bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('baseline-permission', async () => {
    const list = await sessions();
    const target = list.find((s) => s.sessionId === sessionId);
    const payload = { effective: effectivePermission(target.events), timeline: permissionTimeline(target.events), state: (await arbiterState()).body };
    await writeFile(out('f3-01-baseline.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('open-plugin-page', async () => {
    await openPluginPage();
    const sw = await evaluate(cdp, `(() => { const s=[...document.querySelectorAll('button[role="switch"]')].find(b=>(b.getAttribute('aria-label')??'').includes('dsh-arbiter')); return s ? { label: s.getAttribute('aria-label'), checked: s.getAttribute('aria-checked') } : null; })()`);
    await shot(cdp, out('f3-02-plugin-page.png'));
    await writeFile(out('f3-02-plugin-page.json'), JSON.stringify(sw, null, 2));
    return sw;
  });

  await step('disable-through-manager', async () => {
    const before = await arbiterState();
    const clicked = await toggle();
    const wentOff = await waitToggle('false');
    await sleep(1500);
    const after = await arbiterState();
    const payload = { clicked, wentOff, beforeStatus: before.status, afterStatus: after.status, afterBody: after.body };
    await writeFile(out('f3-03-disabled.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3-03-disabled.png'));
    return payload;
  });

  await step('after-disable-permission-and-logs', async () => {
    const list = await sessions();
    const target = list.find((s) => s.sessionId === sessionId);
    const payload = {
      effective: target === undefined ? null : effectivePermission(target.events),
      timelineTail: target?.timelineTail ?? permissionTimeline(target?.events ?? []).slice(-8),
      state: (await arbiterState()).status,
      switch: await evaluate(cdp, `(() => { const s=[...document.querySelectorAll('button[role="switch"]')].find(b=>(b.getAttribute('aria-label')??'').includes('dsh-arbiter')); return s ? s.getAttribute('aria-checked') : null; })()`),
      nativeControl: await evaluate(cdp, `(() => { const cells=[...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter(e=>e.isConnected); return cells[0]?.innerText ?? null; })()`),
    };
    await writeFile(out('f3-04-after.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('re-enable-for-inflight', async () => {
    await openPluginPage();
    await toggle();
    await waitToggle('true');
    await sleep(2500);
    const state = await arbiterState();
    return { status: state.status };
  });

  await step('inflight-slow-review-then-disable', async () => {
    // The plugin page replaced the conversation view; come back first.
    await backToConversation();
    await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 20000);
    // Start a call whose reviewer stays pending for ~9s, then disable the
    // plugin while the gate is waiting for that review.
    await sendMessage(cdp, 'F3SLOW');
    // Wait until the review request has actually reached the fixture.
    let reviewerSeen = false;
    for (let i = 0; i < 80; i += 1) {
      const found = await evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(() => true).catch(() => false)`);
      const log = await import('node:fs/promises').then((fs) => fs.readFile(join(caseDir, 'reviewer-requests.jsonl'), 'utf8').catch(() => ''));
      if (log.trim() !== '') { reviewerSeen = true; break; }
      await sleep(250);
    }
    const atStart = await arbiterState();
    await openPluginPage();
    const clicked = await toggle();
    const wentOff = await waitToggle('false');
    const atDisable = await arbiterState();
    await sleep(2500);
    const after = await arbiterState();
    const session = (await sessions()).find((s) => s.sessionId === sessionId);
    const payload = {
      reviewerSeen, clicked, wentOff,
      atStart: atStart.status, atDisable: atDisable.status, after: after.status,
      effective: session === undefined ? null : effectivePermission(session.events),
      timelineTail: permissionTimeline(session?.events ?? []).slice(-6),
      markers: await import('node:fs/promises').then(async (fs) => ({
        slow: await fs.readFile(join(host.handle.workspace, 'f3-slow.txt'), 'utf8').catch(() => null),
      })),
    };
    await writeFile(out('f3-06-inflight.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3-06-inflight.png'));
    return payload;
  });

  await step('wait-for-review-to-settle', async () => {
    // Give the fixture's 9s window time to elapse and the turn to settle.
    await sleep(12000);
    const session = (await sessions()).find((s) => s.sessionId === sessionId);
    const payload = {
      markers: await import('node:fs/promises').then(async (fs) => ({
        slow: await fs.readFile(join(host.handle.workspace, 'f3-slow.txt'), 'utf8').catch(() => null),
      })),
      decisions: (session?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, ignorable: e.ignorable, result: e.data?.result })),
      lastResults: (session?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 160) })),
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-500),
    };
    await writeFile(out('f3-07-settled.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('new-call-while-disabled', async () => {
    // The plugin page is still open from the disable step; return first.
    await backToConversation();
    // The plugin is unloaded: a new call must run under the host's own policy,
    // with no arbiter gate, no error and no leftover permission change.
    await sendMessage(cdp, 'F3AFTER');
    await sleep(6000);
    const session = (await sessions()).find((s) => s.sessionId === sessionId);
    const payload = {
      marker: await import('node:fs/promises').then((fs) => fs.readFile(join(host.handle.workspace, 'f3-after.txt'), 'utf8').catch(() => null)),
      lastResults: (session?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 160) })),
      effective: session === undefined ? null : effectivePermission(session.events),
    };
    await writeFile(out('f3-08-while-disabled.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('re-enable-through-manager', async () => {
    await openPluginPage();
    const clicked = await toggle();
    const wentOn = await waitToggle('true');
    await sleep(2500);
    const state = await arbiterState();
    const payload = { clicked, wentOn, status: state.status, body: state.body };
    await writeFile(out('f3-05-reenabled.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3-05-reenabled.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f3-final.png')).catch(() => {});
  await writeFile(out('f3-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length) console.log(JSON.stringify(failed, null, 2).slice(0, 2500));
}
