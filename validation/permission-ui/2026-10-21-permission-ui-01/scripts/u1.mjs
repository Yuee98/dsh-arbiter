/**
 * U1: permission-menu coverage and the two execution boundaries.
 *
 * Real Web client (headless Edge over CDP) against an isolated Web host whose
 * profile mounts the validation probe. Everything observed here is a real
 * host run; the probe is a fixture, not product code.
 */
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { boot, logEvents, marker } from './run.mjs';
import { connect, evaluate, setCookie, shot, waitFor } from './cdp.mjs';
import { dismissOverlays } from './ui.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57241);
await mkdir(caseDir, { recursive: true });

const out = (name) => join(caseDir, name);
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

const { copyFile } = await import('node:fs/promises');
await copyFile(new URL('../scenarios/u1.json', import.meta.url), join(caseDir, 'scenario.json'));
const host = await boot(caseDir, port);
const handle = host.handle;
const cdp = await connect();
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 30000);
await dismissOverlays(cdp);

const api = (path, payload) => evaluate(cdp, `fetch('/api/pui${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: ${JSON.stringify(JSON.stringify(payload ?? {}))} }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const get = (path) => evaluate(cdp, `fetch('/api/pui${path}', { credentials: 'include' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const slotState = () => evaluate(cdp, `(() => {
  const cell = document.querySelector('[data-slot="conversation.input.permission"]');
  const select = cell?.querySelector('[data-pui-selector="trigger"]');
  return {
    cellText: cell?.innerText ?? null,
    nativeControl: cell?.querySelector('button') !== null,
    puiPresent: select !== null,
    puiDot: cell?.querySelector('[data-pui-selector="dot"]')?.textContent ?? null,
    options: select ? [...select.options].map((o) => ({ value: o.value, label: o.textContent })) : [],
    selected: select?.value ?? null,
  };
})()`);

const send = async (text) => {
  await dismissOverlays(cdp);
  await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};

const waitTranscript = (text, ms = 60000) => waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`, ms);
const liveSession = async () => {
  const state = await get('/state');
  const ids = Object.keys(state.sessions ?? {});
  return ids.length === 0 ? undefined : ids[ids.length - 1];
};

try {
  await shot(cdp, out('u1-00-loaded.png'));

  const sessionId = await step('session', async () => {
    await send('U1 bootstrap');
    for (let i = 0; i < 80; i += 1) {
      const state = await get('/state');
      const ids = Object.keys(state.sessions ?? {});
      if (ids.length > 0) return ids[0];
      await sleep(400);
    }
    throw new Error('no live session');
  });

  await step('slot-initial', async () => {
    const state = await slotState();
    await writeFile(out('u1-01-slot-initial.json'), JSON.stringify({ state, events: (await logEvents(handle)).slice(-5) }, null, 2));
    await shot(cdp, out('u1-01-slot-initial.png'));
    return state;
  });

  await step('enable-guarded-via-selector', async () => {
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    const on = await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]')?.innerText.includes('·')`, 15000);
    const status = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    const sessionEvents = await get(`/session-events?sessionId=${encodeURIComponent(sessionId)}`);
    await writeFile(out('u1-02-enable.json'), JSON.stringify({ on, status, sessionEvents }, null, 2));
    await shot(cdp, out('u1-02-enabled-guarded.png'));
    return { on, status };
  });

  const runMarker = async (tag, markerFile, options = {}) => {
    await send(tag);
    const done = await waitTranscript(`${tag}-DONE`, options.timeout ?? 90000);
    const events = await logEvents(handle);
    const sessionEvents = await get(`/session-events?sessionId=${encodeURIComponent(sessionId)}`);
    const body = await evaluate(cdp, 'document.body.innerText');
    const file = await marker(markerFile);
    const results = (sessionEvents.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({
      seq: e.seq,
      isError: e.data?.message?.isError === true,
      text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 400),
    }));
    const calls = (sessionEvents.events ?? []).filter((e) => e.type === 'tool/call').map((e) => ({ seq: e.seq, name: e.data?.name, arguments: e.data?.arguments }));
    const payload = { done, results, calls, events: events.filter((e) => ['gate/call', 'gate/allow', 'gate/deny', 'gate/released', 'review/inflight', 'review/settled', 'approval/opening', 'approval/outcome'].includes(e.event)), sessionEvents, marker: file, bodyTail: body.slice(-1500) };
    await writeFile(out(options.file ?? `${tag}.json`), JSON.stringify(payload, null, 2));
    return payload;
  };

  await step('guarded-allow', async () => {
    const r = await runMarker('U1ALLOWA', join(handle.workspace, 'guarded-allow.txt'), { file: 'u1-03-guarded-allow.json' });
    await shot(cdp, out('u1-03-guarded-allow.png'));
    return { done: r.done, marker: r.marker, gates: r.events.map((e) => e.event) };
  });

  await step('guarded-deny', async () => {
    const r = await runMarker('U1DENYB', join(handle.workspace, 'guarded-deny.txt'), { file: 'u1-04-guarded-deny.json' });
    await shot(cdp, out('u1-04-guarded-deny.png'));
    return { done: r.done, marker: r.marker, gates: r.events.map((e) => e.event) };
  });

  await step('guarded-outside-write', async () => {
    const r = await runMarker('U1OUTSIDEC', join(handle.outside, 'guarded-outside.txt'), { file: 'u1-05-guarded-outside.json' });
    await shot(cdp, out('u1-05-guarded-outside.png'));
    return { done: r.done, marker: r.marker, gates: r.events.map((e) => e.event) };
  });

  await step('host-options-preserved', async () => {
    const state = await slotState();
    await writeFile(out('u1-06-options.json'), JSON.stringify(state, null, 2));
    return state;
  });

  await step('trusted-boundary', async () => {
    // Boundary change without disabling: the product's config page plays this
    // role; the probe route stands in for it. No session was switched out.
    const before = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    await api('/enable', { sessionId, boundary: 'trusted', origin: 'config-page' });
    const after = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    const r = await runMarker('U1TRUSTEDD', join(handle.outside, 'trusted-outside.txt'), { file: 'u1-07-trusted-outside.json' });
    await shot(cdp, out('u1-07-trusted-outside.png'));
    return { before: before.status, after: after.status, done: r.done, marker: r.marker, gates: r.events.map((e) => e.event) };
  });

  await step('second-session-not-taken-over', async () => {
    const clicked = await evaluate(cdp, `(() => { const b = [...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') ?? '') === '新建会话'); b?.click(); return b !== undefined; })()`);
    await sleep(2500);
    await dismissOverlays(cdp);
    await send('U1NEWSESSIONE');
    const done = await waitTranscript('U1NEWSESSIONE-DONE', 90000);
    const state = await get('/state');
    const events = await logEvents(handle);
    const ids = Object.keys(state.sessions ?? {});
    const second = ids.find((id) => id !== sessionId);
    await writeFile(out('u1-08-second-session.json'), JSON.stringify({ clicked, ids, sessions: state.sessions, done, gates: events.filter((e) => e.event.startsWith('gate/')), second }, null, 2));
    await shot(cdp, out('u1-08-second-session.png'));
    return { clicked, second, secondStatus: second === undefined ? null : state.sessions[second], done };
  });

  await step('override-removed-restores-native', async () => {
    const removed = await evaluate(cdp, `(() => { window.__puiControl.remove(); return true; })()`);
    await sleep(2000);
    const state = await slotState();
    const status = await get(`/status?sessionId=${encodeURIComponent(sessionId)}`);
    await writeFile(out('u1-09-override-removed.json'), JSON.stringify({ removed, state, status }, null, 2));
    await shot(cdp, out('u1-09-override-removed.png'));
    return { removed, state, status };
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('u1-final.png')).catch(() => {});
  await writeFile(out('u1-steps.json'), JSON.stringify(steps, null, 2));
  cdp.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 4000));
}
