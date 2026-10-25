/**
 * U4: client override removal, whole-plugin unload, in-flight review, a pending
 * manual approval, host cancellation, and reopening a closed session.
 *
 * Every step is a real browser + real host interaction against an isolated
 * DSH_HOME. The probe implements the product's intended unload order (stop
 * taking new work → drain → roll back only still-managed sessions).
 */
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot, logEvents, marker } from './run.mjs';
import { connect, evaluate, setCookie, shot, waitFor } from './cdp.mjs';
import { dismissOverlays } from './ui.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57471);
const mode = process.argv[4] ?? 'main';
await mkdir(caseDir, { recursive: true });
await copyFile(new URL('../scenarios/u4.json', import.meta.url), join(caseDir, 'scenario.json'));

const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try {
    const value = await fn();
    steps.push({ name, ok: true, ms: Date.now() - started, value });
    return value;
  } catch (error) {
    steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) });
    throw error;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const host = await boot(caseDir, port);
let cdp = await connect();
const open = async (handle) => {
  await setCookie(cdp, handle.origin, handle.cookie);
  await cdp.send('Page.navigate', { url: handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 30000);
  await dismissOverlays(cdp);
};
await open(host.handle);

const get = (path) => evaluate(cdp, `fetch('/api/pui${path}', { credentials: 'include' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const api = (path, payload) => evaluate(cdp, `fetch('/api/pui${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: ${JSON.stringify(JSON.stringify(payload ?? {}))} }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const send = async (text) => {
  await dismissOverlays(cdp);
  await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const events = () => logEvents(host.handle);
const activeSession = async () => {
  const state = await get('/state');
  const ids = Object.keys(state.sessions ?? {});
  return ids[ids.length - 1];
};
const selectorState = () => evaluate(cdp, `(() => {
  const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter((el) => el.isConnected);
  const cell = cells[0];
  const select = cell?.querySelector('[data-pui-selector="trigger"]');
  return { cells: cells.length, cellText: cell?.innerText ?? null, nativeControl: cell?.querySelector('button') !== null, puiPresent: select !== null, selected: select?.value ?? null };
})()`);
const enableViaSelector = () => evaluate(cdp, `(() => {
  const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')];
  const s = cells[0]?.querySelector('[data-pui-selector="trigger"]');
  if (!s) return false;
  s.value = '__arbiter__';
  s.dispatchEvent(new Event('change', { bubbles: true }));
  return true;
})()`);

try {
  const sessionId = await step('session', async () => {
    await send('U4 bootstrap');
    for (let i = 0; i < 80; i += 1) {
      const state = await get('/state');
      const ids = Object.keys(state.sessions ?? {});
      if (ids.length > 0) return ids[0];
      await sleep(400);
    }
    throw new Error('no live session');
  });

  await step('enable-guarded', async () => {
    await enableViaSelector();
    await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]').innerText.includes('·')`, 15000);
    return { status: (await get('/status?sessionId=' + encodeURIComponent(sessionId))).status, selector: await selectorState() };
  });

  if (mode === 'main') {
    await step('client-override-removal-only', async () => {
      const before = (await get('/status?sessionId=' + encodeURIComponent(sessionId))).status;
      await evaluate(cdp, `(() => { window.__puiControl.remove(); return true; })()`);
      await sleep(2000);
      const after = (await get('/status?sessionId=' + encodeURIComponent(sessionId))).status;
      const payload = { before, after, selector: await selectorState() };
      await writeFile(join(caseDir, 'u4-01-override-removal.json'), JSON.stringify(payload, null, 2));
      await shot(cdp, join(caseDir, 'u4-01-override-removal.png'));
      return payload;
    });

    await step('inflight-review-during-unload', async () => {
      // Session A stays the UI session. Start a slow review, then unload with a
      // 12 s drain window: the plugin must not cancel the review, and the
      // unload must wait for it.
      await send('U4SLOWALLOW');
      // Wait until the probe is actually inside the delayed review: the model
      // call and the tool dispatch happen a few seconds after the turn starts.
      const inflight = await waitFor(cdp, `true`, 1, 1).then(async () => {
        for (let i = 0; i < 60; i += 1) {
          const snapshot = await events();
          if (snapshot.some((e) => e.event === 'review/inflight')) return true;
          await sleep(500);
        }
        return false;
      });
      const during = await get('/active');
      const unload = await api('/unload', { drainMs: 12000 });
      await sleep(3500);
      const midEvents = (await events()).filter((e) => ['pui/dispose-begin', 'pui/dispose-wait', 'pui/dispose-drained', 'review/inflight', 'review/settled', 'pui/dispose-rollback', 'pui/dispose-skip', 'pui/dispose-end', 'pui/unload-disposed'].includes(e.event));
      await sleep(9000);
      const afterEvents = (await events()).filter((e) => ['pui/dispose-begin', 'pui/dispose-wait', 'pui/dispose-drained', 'review/inflight', 'review/settled', 'pui/dispose-rollback', 'pui/dispose-skip', 'pui/dispose-end', 'pui/unload-disposed', 'gate/released'].includes(e.event));
      const status = (await get('/status?sessionId=' + encodeURIComponent(sessionId))).status;
      const payload = { sessionId, inflight, during, unload, midEvents, afterEvents, status, marker: await marker(join(host.handle.workspace, 'u4-slow-allow.txt')) };
      await writeFile(join(caseDir, 'u4-03-inflight-unload.json'), JSON.stringify(payload, null, 2));
      return payload;
    });

    await step('post-unload-routes-gone', async () => {
      const routes = await get('/state').catch((error) => ({ error: String(error) }));
      const payload = { routes, selector: await selectorState().catch(() => null) };
      await writeFile(join(caseDir, 'u4-04-post-unload.json'), JSON.stringify(payload, null, 2));
      return payload;
    });

    await step('reopen-after-unload', async () => {
      // Restart with the plugin still in the profile: the session log must load
      // (only ignorable records on it) and the rollback must hold.
      cdp.close();
      await host.stop();
      const restarted = await boot(caseDir, port);
      cdp = await connect();
      await open(restarted.handle);
      await sleep(2000);
      const resumed = await api('/resume', { sessionId });
      const state = await get('/state');
      const log = await events();
      const sessionEvents = await get(`/session-events?sessionId=${encodeURIComponent(sessionId)}`);
      const payload = {
        resumed,
        status: state.sessions?.[sessionId] ?? null,
        rollbackEvents: log.filter((e) => e.sessionId === sessionId && ['sandbox/mode', 'approval/policy', 'plugin:pui/disabled'].includes(e.type)).map((e) => ({ type: e.type, data: e.data })),
        restored: log.filter((e) => e.event === 'pui/restored' && e.sessionId === sessionId),
        ignorableRecords: (sessionEvents.events ?? []).filter((e) => e.type.startsWith('plugin:')).map((e) => ({ type: e.type, ignorable: e.ignorable })),
        selector: await selectorState(),
      };
      await writeFile(join(caseDir, 'u4-05-reopen.json'), JSON.stringify(payload, null, 2));
      await shot(cdp, join(caseDir, 'u4-05-reopen.png'));
      return payload;
    });

    await step('user-switched-not-overwritten', async () => {
      // A fresh UI session, enabled, then moved off arbiter by the native
      // command: unload must skip it instead of rolling it back.
      await evaluate(cdp, `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '') === '新建会话'); b?.click(); return b !== undefined; })()`);
      await sleep(2500);
      await dismissOverlays(cdp);
      await send('U4 bootstrap two');
      await sleep(2000);
      const fresh = await activeSession();
      await api('/enable', { sessionId: fresh, boundary: 'guarded', origin: 'client-selector' });
      await sleep(800);
      await send('/permission read-only');
      await sleep(2500);
      const before = (await get('/status?sessionId=' + encodeURIComponent(fresh))).status;
      const sandboxBefore = await get('/sandbox?sessionId=' + encodeURIComponent(fresh));
      await api('/unload', { drainMs: 0 });
      await sleep(2500);
      const log = await events();
      const payload = {
        fresh, before, sandboxBefore,
        skipped: log.filter((e) => e.event === 'pui/dispose-skip' && e.sessionId === fresh),
        rolledBack: log.filter((e) => e.event === 'pui/dispose-rollback' && e.sessionId === fresh),
        modeEvents: log.filter((e) => e.event === 'session/event' && e.sessionId === fresh && e.type === 'sandbox/mode').map((e) => e.data),
      };
      await writeFile(join(caseDir, 'u4-06-user-switched.json'), JSON.stringify(payload, null, 2));
      return payload;
    });
  }

  if (mode === 'approval') {
    await step('pending-approval-survives-switch', async () => {
      // The probe's held answerer keeps the approval pending. Switch the
      // session's host policy while it waits, then observe the outcome.
      await send('U4SLOWASK');
      // Wait for the approval to be genuinely pending before switching.
      let opened = [];
      for (let i = 0; i < 120; i += 1) {
        opened = (await events()).filter((e) => ['review/inflight', 'review/settled', 'approval/opening', 'approval/answerer-arrived', 'approval/outcome', 'approval/answerer-settled', 'approval/threw'].includes(e.event));
        if (opened.some((e) => e.event === 'approval/answerer-arrived' || e.event === 'approval/opening')) break;
        await sleep(500);
      }
      const beforeSwitch = (await events()).filter((e) => ['approval/opening', 'approval/answerer-arrived'].includes(e.event));
      // The composer is blocked while an approval is pending; use the same
      // public session.command() path the native selector uses.
      const switchResult = await evaluate(cdp, `window.__puiCommand(${JSON.stringify(sessionId)}, '/permission danger-full-access')`);
      await sleep(4000);
      const afterSwitch = (await events()).filter((e) => ['review/inflight', 'review/settled', 'approval/opening', 'approval/answerer-arrived', 'approval/outcome', 'approval/answerer-settled', 'approval/threw'].includes(e.event));
      const status = (await get('/status?sessionId=' + encodeURIComponent(sessionId))).status;
      const sessionEvents = await get(`/session-events?sessionId=${encodeURIComponent(sessionId)}`);
      const completion = await Promise.race([
        (async () => { for (let i = 0; i < 60; i += 1) { const snap = await events(); if (snap.some((e) => e.event === 'approval/outcome' || e.event === 'approval/answerer-settled')) return snap; await sleep(500); } return await events(); })(),
        (async () => { await sleep(30000); return await events(); })(),
      ]);
      const payload = {
        opened, beforeSwitch, afterSwitch,
        switchResult,
        settled: completion.filter((e) => ['review/inflight', 'review/settled', 'approval/opening', 'approval/answerer-arrived', 'approval/outcome', 'approval/answerer-settled', 'approval/threw', 'gate/allow', 'gate/deny'].includes(e.event)),
        status,
        approvalEvents: (sessionEvents.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ type: e.type, data: e.data })),
        bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-900),
      };
      await writeFile(join(caseDir, 'u4-07-pending-approval.json'), JSON.stringify(payload, null, 2));
      await shot(cdp, join(caseDir, 'u4-07-pending-approval.png'));
      return payload;
    });
  }
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, join(caseDir, `u4-${mode}-final.png`)).catch(() => {});
  await writeFile(join(caseDir, `u4-${mode}-steps.json`), JSON.stringify(steps, null, 2));
  try { cdp.close(); } catch {}
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 3000));
}
