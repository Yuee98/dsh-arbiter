/**
 * U3: page refresh, disconnect/reconnect with a newer state, cold host restart,
 * and enablement restore without the audit database.
 */
import { writeFile, mkdir, copyFile, rename, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot, logEvents, marker } from './run.mjs';
import { connect, evaluate, setCookie, shot, waitFor } from './cdp.mjs';
import { dismissOverlays } from './ui.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57341);
await mkdir(caseDir, { recursive: true });
await copyFile(new URL('../scenarios/u3.json', import.meta.url), join(caseDir, 'scenario.json'));

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

let host = await boot(caseDir, port);
let cdp = await connect();
const open = async (handle) => {
  await setCookie(cdp, handle.origin, handle.cookie);
  await cdp.send('Page.navigate', { url: handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 30000);
  await dismissOverlays(cdp);
};
await open(host.handle);
await shot(cdp, join(caseDir, 'u3-00-loaded.png'));

/** A second, independent connection to the same host (not the browser). */
const secondConnection = (handle) => ({
  get: async (path) => (await fetch(handle.origin + path, { headers: { cookie: handle.cookie } })).json(),
  post: async (path, payload) => (await fetch(handle.origin + path, {
    method: 'POST', headers: { cookie: handle.cookie, 'content-type': 'application/json' }, body: JSON.stringify(payload ?? {}),
  })).json(),
});

const api = (path, payload) => evaluate(cdp, `fetch('/api/pui${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: ${JSON.stringify(JSON.stringify(payload ?? {}))} }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const get = (path) => evaluate(cdp, `fetch('/api/pui${path}', { credentials: 'include' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const send = async (text) => {
  await dismissOverlays(cdp);
  await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const waitTranscript = (text, ms = 90000) => waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`, ms);
const selectorState = () => evaluate(cdp, `(() => {
  // Any mounted composer cell counts, visible or virtualized; detached nodes
  // from a previous page generation are excluded by isConnected.
  const cells = [...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter((el) => el.isConnected);
  const cell = cells[0];
  const select = cell?.querySelector('[data-pui-selector="trigger"]');
  return {
    cells: cells.length,
    cellText: cell?.innerText ?? null,
    puiDot: cell?.querySelector('[data-pui-selector="dot"]')?.textContent ?? null,
    selected: select?.value ?? null,
    enabled: (cell?.innerText ?? '').includes('·') || select?.value === '__arbiter__',
  };
})()`);

/**
 * Materialize a stored session on a cold host.
 *
 * A cold host holds no agent until something resumes one. The probe route
 * calls the public `agents.resume({ sessionId })` API, which is the same
 * host path the GUI uses when the user opens a stored session.
 */
const resumeExisting = async (targetId) => {
  const result = await api('/resume', { sessionId: targetId });
  await sleep(2000);
  return result;
};

try {
  const sessionId = await step('session', async () => {
    await send('U3 bootstrap');
    for (let i = 0; i < 80; i += 1) {
      const state = await get('/state');
      const ids = Object.keys(state.sessions ?? {});
      if (ids.length > 0) return ids[0];
      await sleep(400);
    }
    throw new Error('no live session');
  });

  await step('enable-guarded', async () => {
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(cdp, `document.querySelector('[data-pui-selector="dot"]')?.textContent === '●'`, 15000);
    await send('U3ENABLE');
    await waitTranscript('U3ENABLE-DONE');
    return { status: (await get(`/status?sessionId=${encodeURIComponent(sessionId)}`)).status, selector: await selectorState() };
  });

  await step('page-refresh', async () => {
    const before = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    await cdp.send('Page.reload', { ignoreCache: false });
    await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 30000);
    await dismissOverlays(cdp);
    await sleep(2500);
    const after = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    const state = await selectorState();
    const payload = { before: before.status, after: after.status, selector: state };
    await writeFile(join(caseDir, 'u3-01-refresh.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-01-refresh.png'));
    return payload;
  });

  await step('disconnect-newer-state-not-overwritten', async () => {
    // Take the page offline, change the backend through a second connection,
    // bring the page back and confirm it adopts the newer state.
    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(1500);
    const second = secondConnection(host.handle);
    const disabled = await second.post('/api/pui/disable', { sessionId, reason: 'second-connection' });
    const remoteStatus = await second.get(`/api/pui/status?sessionId=${encodeURIComponent(sessionId)}`);
    const whileOffline = await selectorState().catch(() => ({ note: 'page unavailable while offline' }));
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await sleep(4000);
    const afterReconnect = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    const state = await selectorState();
    const payload = { disabled, remoteStatus, whileOffline, afterReconnect: afterReconnect.status, selector: state };
    await writeFile(join(caseDir, 'u3-02-disconnect.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-02-disconnect.png'));
    return payload;
  });

  await step('late-response-ignored', async () => {
    // Re-enable through the page, then immediately disable through the second
    // connection: the page's in-flight optimistic read must not win.
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(300);
    const second = secondConnection(host.handle);
    await second.post('/api/pui/disable', { sessionId, reason: 'late-response-probe' });
    await sleep(4000);
    const state = await selectorState();
    const status = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    const payload = { selector: state, status: status.status };
    await writeFile(join(caseDir, 'u3-03-late.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-03-late.png'));
    return payload;
  });

  await step('cold-restart-restore', async () => {
    // Re-enable, remember, then restart the host process with the same home.
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(1500);
    const before = (await get(`/status?sessionId=${encodeURIComponent(sessionId)}`)).status;
    const auditPath = join(host.handle.home, 'arbiter', 'arbiter.db');
    const auditBefore = existsSync(auditPath);
    cdp.close();
    await host.stop();
    // Restart on the same home and port.
    host = await boot(caseDir, port);
    cdp = await connect();
    await open(host.handle);
    await sleep(2500);
    // A cold host materializes a session only when it is opened.
    const resumed = await resumeExisting(sessionId);
    await sleep(1500);
    const state = await get('/state');
    const status = state.sessions?.[sessionId];
    const restoredEvents = (await logEvents(host.handle)).filter((e) => e.event === 'pui/restored');
    const payload = { resumed, before, after: status, auditBefore, auditPath, restoredEvents, selector: await selectorState() };
    await writeFile(join(caseDir, 'u3-04-cold-restart.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-04-cold-restart.png'));
    return payload;
  });

  await step('post-restart-gate-still-active', async () => {
    await send('U3AFTER');
    await waitTranscript('U3AFTER-DONE');
    const events = (await logEvents(host.handle)).filter((e) => e.sessionId === sessionId && e.event.startsWith('gate/'));
    const payload = { gates: events.map((e) => e.event), marker: await marker(join(host.handle.workspace, 'u3-deny.txt')) };
    await writeFile(join(caseDir, 'u3-05-post-restart.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-05-post-restart.png'));
    return payload;
  });

  await step('new-session-not-enabled-after-restart', async () => {
    await evaluate(cdp, `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '') === '新建会话'); b?.click(); return b !== undefined; })()`);
    await sleep(2500);
    await dismissOverlays(cdp);
    const state = await get('/state');
    const ids = Object.keys(state.sessions ?? {});
    const fresh = ids.find((id) => id !== sessionId);
    const payload = { ids, fresh, freshStatus: fresh === undefined ? null : state.sessions[fresh], enabledStatus: state.sessions[sessionId] };
    await writeFile(join(caseDir, 'u3-06-new-session.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-06-new-session.png'));
    return payload;
  });

  await step('audit-database-removed', async () => {
    // Remove any audit database from the isolated home, restart, and verify the
    // enablement still restores from the session log alone.
    const auditDir = join(host.handle.home, 'arbiter');
    const moved = join(caseDir, 'audit-moved-away');
    if (existsSync(auditDir)) await rename(auditDir, moved);
    await writeFile(join(caseDir, 'u3-audit-moved.txt'), `moved=${existsSync(auditDir) ? 'no' : 'yes'}\nfrom=${auditDir}\nto=${moved}\n`);
    cdp.close();
    await host.stop();
    host = await boot(caseDir, port);
    cdp = await connect();
    await open(host.handle);
    await sleep(2500);
    const resumed = await resumeExisting(sessionId);
    await sleep(1500);
    const state = await get('/state');
    const restored = (await logEvents(host.handle)).filter((e) => e.event === 'pui/restored');
    const payload = { resumed, sessionId, auditPresent: existsSync(join(host.handle.home, 'arbiter', 'arbiter.db')), enabled: state.sessions?.[sessionId], restored, selector: await selectorState() };
    await writeFile(join(caseDir, 'u3-07-audit-removed.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u3-07-audit-removed.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, join(caseDir, 'u3-final.png')).catch(() => {});
  await writeFile(join(caseDir, 'u3-steps.json'), JSON.stringify(steps, null, 2));
  try { cdp.close(); } catch {}
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 3000));
}
