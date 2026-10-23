/**
 * U2: native /permission command synchronization.
 *
 * Covers (a) explicit /permission <preset> with a value change, (b) the hard
 * case — /permission workspace-write while arbiter+guarded already sits at
 * workspace-write, where the host appends nothing and emits no change, and
 * (c) /permission auto under a guarded config.
 */
import { writeFile, mkdir, copyFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot, logEvents, marker } from './run.mjs';
import { connect, evaluate, setCookie, shot, waitFor } from './cdp.mjs';
import { dismissOverlays } from './ui.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57311);
await mkdir(caseDir, { recursive: true });
await copyFile(new URL('../scenarios/u2.json', import.meta.url), join(caseDir, 'scenario.json'));

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

const host = await boot(caseDir, port);
const handle = host.handle;
const cdp = await connect();
await setCookie(cdp, handle.origin, handle.cookie);
await cdp.send('Page.navigate', { url: handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 30000);
await dismissOverlays(cdp);

const get = (path) => evaluate(cdp, `fetch('/api/pui${path}', { credentials: 'include' }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const api = (path, payload) => evaluate(cdp, `fetch('/api/pui${path}', { method: 'POST', headers: { 'content-type': 'application/json' }, credentials: 'include', body: ${JSON.stringify(JSON.stringify(payload ?? {}))} }).then(r => r.json()).catch(e => ({ ok: false, error: String(e) }))`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const send = async (text) => {
  await dismissOverlays(cdp);
  await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
  await cdp.send('Input.insertText', { text });
  await sleep(250);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
};
const waitTranscript = (text, ms = 90000) => waitFor(cdp, `document.body.innerText.includes(${JSON.stringify(text)})`, ms);

/** Run one slash command exactly as a user would (typed into the composer). */
const clearComposer = async () => {
  await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 4 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
  await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8 });
};

/**
 * Submit a literal slash command and verify the host logged exactly that
 * argument text. The composer's completion popup rewrites some inputs, so a
 * mismatch is retried once without a pause (before completion settles).
 */
const runCommand = async (line) => {
  const expected = line.slice('/permission'.length);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await dismissOverlays(cdp);
    await clearComposer();
    await evaluate(cdp, `document.querySelector('[contenteditable="true"]').focus()`);
    await cdp.send('Input.insertText', { text: line });
    if (attempt === 0) await sleep(400);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
    await sleep(1500);
    const events = (await get('/events')).events ?? [];
    const runs = events.filter((e) => e.event === 'session/event' && e.type === 'command/run');
    const last = runs[runs.length - 1];
    if (last !== undefined && last.data.name === 'permission' && last.data.args === expected) return last;
    await clearComposer();
  }
  return undefined;
  const state = await get('/events');
  return state;
};

const sessionSnapshot = async () => {
  const state = await get('/state');
  const ids = Object.keys(state.sessions ?? {});
  const id = ids[0];
  const events = await get(`/session-events?sessionId=${encodeURIComponent(id)}`);
  const host = await api('/host', { sessionId: id, op: 'current' });
  return { id, state: state.sessions[id], sessionEvents: events, hostCurrent: host.current };
};

try {
  await shot(cdp, out('u2-00-loaded.png'));
  const sessionId = await step('session', async () => {
    await send('U2 base');
    for (let i = 0; i < 80; i += 1) {
      const state = await get('/state');
      const ids = Object.keys(state.sessions ?? {});
      if (ids.length > 0) return ids[0];
      await sleep(400);
    }
    throw new Error('no live session');
  });

  const baseline = await step('enable-guarded', async () => {
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]')?.innerText.includes('·')`, 15000);
    return sessionSnapshot();
  });

  await step('same-value-workspace-write', async () => {
    // Precondition: the host's own value is already workspace-write, so the
    // native handler appends neither permission/preset nor sandbox/mode.
    const before = await sessionSnapshot();
    const beforeSeq = before.sessionEvents.seq;
    const beforeTypes = before.sessionEvents.events.map((e) => e.type);
    await runCommand('/permission workspace-write');
    await sleep(1500);
    const after = await sessionSnapshot();
    const appended = after.sessionEvents.events.slice(before.eventsCount ?? beforeTypes.length).map((e) => ({ type: e.type, data: e.data }));
    const newTypes = after.sessionEvents.events.map((e) => e.type).slice(beforeTypes.length);
    const payload = {
      before: { enabled: before.state.enabled, boundary: before.state.boundary, hostCurrent: before.hostCurrent, seq: beforeSeq },
      after: { enabled: after.state.enabled, boundary: after.state.boundary, hostCurrent: after.hostCurrent, seq: after.sessionEvents.seq },
      newEvents: after.sessionEvents.events.slice(beforeTypes.length),
      hostValueUnchanged: before.hostCurrent === after.hostCurrent,
      noKnobEvents: !newTypes.includes('sandbox/mode') && !newTypes.includes('permission/preset'),
      commandRunLogged: newTypes.includes('command/run'),
    };
    await writeFile(join(caseDir, 'u2-01-same-value.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-01-same-value.png'));
    return payload;
  });

  await step('post-exit-not-taken-over', async () => {
    await send('U2DENY');
    const done = await waitTranscript('U2DENY-DONE');
    const snap = await sessionSnapshot();
    const events = (await logEvents(handle)).filter((e) => e.sessionId === sessionId);
    const payload = {
      done,
      enabled: snap.state.enabled,
      hostCurrent: snap.hostCurrent,
      gatesAfterExit: events.filter((e) => e.event.startsWith('gate/')),
      results: snap.sessionEvents.events.filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 200) })),
      marker: await marker(join(handle.workspace, 'u2-deny.txt')),
    };
    await writeFile(join(caseDir, 'u2-02-post-exit.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-02-post-exit.png'));
    return payload;
  });

  await step('explicit-read-only', async () => {
    const before = await sessionSnapshot();
    const run = await runCommand('/permission read-only');
    await sleep(1500);
    const after = await sessionSnapshot();
    const payload = {
      run,
      before: { enabled: before.state.enabled, hostCurrent: before.hostCurrent },
      after: { enabled: after.state.enabled, hostCurrent: after.hostCurrent },
      tail: after.sessionEvents.events.slice(-6),
    };
    await writeFile(join(caseDir, 'u2-03-read-only.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-03-read-only.png'));
    return payload;
  });

  await step('explicit-danger-full-access', async () => {
    const run = await runCommand('/permission danger-full-access');
    await sleep(1500);
    const after = await sessionSnapshot();
    const payload = { run, after: { enabled: after.state.enabled, hostCurrent: after.hostCurrent }, tail: after.sessionEvents.events.slice(-6) };
    await writeFile(join(caseDir, 'u2-04-full-access.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-04-full-access.png'));
    return payload;
  });

  await step('bare-permission-picker', async () => {
    await send('/permission');
    await sleep(2000);
    const body = await evaluate(cdp, `document.body.innerText`);
    const picker = await evaluate(cdp, `(() => {
      const items = [...document.querySelectorAll('[role="option"], [role="menuitem"], li')].map((e) => (e.innerText ?? '').trim()).filter((t) => t.length > 0 && t.length < 40);
      return items.slice(0, 12);
    })()`);
    await writeFile(join(caseDir, 'u2-05-bare-picker.json'), JSON.stringify({ picker, bodyTail: body.slice(-800) }, null, 2));
    await shot(cdp, join(caseDir, 'u2-05-bare-picker.png'));
    return { picker };
  });

  await step('re-enable-then-auto', async () => {
    // Back to arbiter+guarded, then /permission auto under guarded config.
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(1500);
    const before = await sessionSnapshot();
    const run = await runCommand('/permission auto');
    await sleep(2000);
    const after = await sessionSnapshot();
    const log = await logEvents(handle);
    const payload = {
      before: { enabled: before.state.enabled, boundary: before.state.boundary, hostCurrent: before.hostCurrent },
      after: { enabled: after.state.enabled, boundary: after.state.boundary, hostCurrent: after.hostCurrent, reason: after.state.reason },
      run,
      autoAdmitted: log.filter((e) => e.event === 'auto/admitted').length,
      tail: after.sessionEvents.events.slice(-8),
    };
    await writeFile(join(caseDir, 'u2-06-auto.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-06-auto.png'));
    return payload;
  });

  await step('post-auto-tool-call', async () => {
    await send('U2AUTO');
    const done = await waitTranscript('U2AUTO-DONE');
    const snap = await sessionSnapshot();
    const payload = {
      done,
      hostCurrent: snap.hostCurrent,
      enabled: snap.state.enabled,
      gates: (await logEvents(handle)).filter((e) => e.event.startsWith('gate/') && e.sessionId === sessionId).map((e) => e.event),
      results: snap.sessionEvents.events.filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 240) })),
      marker: await marker(join(handle.workspace, 'u2-auto.txt')),
    };
    await writeFile(join(caseDir, 'u2-07-post-auto.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-07-post-auto.png'));
    return payload;
  });

  await step('control-allow-still-gated', async () => {
    // Re-enable and prove the gate still fires, so the previous results are
    // not an artifact of a dead probe.
    await evaluate(cdp, `(() => { const s = document.querySelector('[data-pui-selector="trigger"]'); s.value = '__arbiter__'; s.dispatchEvent(new Event('change', { bubbles: true })); return true; })()`);
    await sleep(1200);
    await send('U2ALLOWZ');
    const done = await waitTranscript('U2ALLOWZ-DONE');
    const snap = await sessionSnapshot();
    const payload = {
      done,
      enabled: snap.state.enabled,
      gates: (await logEvents(handle)).filter((e) => e.event.startsWith('gate/') && e.sessionId === sessionId).map((e) => e.event),
      marker: await marker(join(handle.workspace, 'u2-allowz.txt')),
    };
    await writeFile(join(caseDir, 'u2-08-control.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, join(caseDir, 'u2-08-control.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, join(caseDir, 'u2-final.png')).catch(() => {});
  await writeFile(join(caseDir, 'u2-steps.json'), JSON.stringify(steps, null, 2));
  cdp.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 3000));
}

function out(name) { return join(caseDir, name); }
