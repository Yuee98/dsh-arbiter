/**
 * F2: native `/permission auto` rejection, on the real plugin.
 *
 * Contract: in a scope where arbiter provides approval, native
 * `/permission auto` is refused before any permission change, in trusted,
 * guarded and not-enabled sessions. The refusal keeps enabled state, sandbox
 * and approval exactly as they were, is not read as a successful exit, and
 * other commands keep working.
 */
import { readdir } from 'node:fs/promises';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, permissionTimeline, effectivePermission, permissionCommands } from './session-log.mjs';
import { sendMessage, submitCommand, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57611);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const value = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value }); return value; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (name) => join(caseDir, name);

const host = await boot(caseDir, port);
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 40000);
await dismissOverlays(cdp);

const state = () => evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(r => r.json())`);

/** Read the live session log from disk (the host's own durable record). */
const sessions = async () => {
  const list = await readSessions(host.handle.home);
  // Only a session that actually ran a turn is the UI session; empty
  // session shells are created for every page load.
  return list
    .filter((s) => s.events.some((e) => e.type === 'turn/end' || e.type === 'turn/start'))
    .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
};
const permissions = async () => {
  const list = await sessions();
  return list.map((s) => ({ sessionId: s.sessionId, permissionCommands: permissionCommands(s.events), timeline: permissionTimeline(s.events), effective: effectivePermission(s.events), header: s.header }));
};
const commands = async () => {
  const list = await sessions();
  return list.flatMap((s) => permissionCommands(s.events).map((c) => ({ ...c, sessionId: s.sessionId })));
};

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F2 bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const list = await sessions();
      const done = list.find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session log');
  });

  await step('state-ready', async () => {
    const s = await state();
    const payload = { autoEntry: s.autoEntry, sessionRecords: s.sessionRecords, enabled: s.enabled };
    await writeFile(out('f2-00-state.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  /** Run `/permission auto` and capture everything before/after. */
  const runAuto = async (label) => {
    const before = await permissions();
    const submission = await submitCommand(cdp, '/permission auto', commands);
    await sleep(1500);
    const after = await permissions();
    const target = after.find((s) => s.sessionId === sessionId);
    const beforeTarget = before.find((s) => s.sessionId === sessionId);
    const payload = {
      label,
      submission,
      before: beforeTarget?.effective,
      after: target?.effective,
      timelineTail: target?.timeline.slice(-8),
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-700),
    };
    await writeFile(out(`f2-${label}.json`), JSON.stringify(payload, null, 2));
    await shot(cdp, out(`f2-${label}.png`));
    return payload;
  };

  await step('auto-rejected-not-enabled', async () => {
    // Same contract in a session that never enabled arbiter: the native entry
    // is still refused, and no permission fact changes.
    const p = await runAuto('00-not-enabled');
    return p;
  });

  await step('auto-rejected-guarded', () => runAuto('01-guarded'));
  await step('auto-rejected-guarded-settled', async () => {
    const after = (await permissions()).find((s) => s.sessionId === sessionId);
    const last = after?.permissionCommands.at(-1) ?? null;
    const payload = { last, effective: after?.effective, autoEntry: (await state()).autoEntry };
    await writeFile(out('f2-02-guarded-settled.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('same-value-exit-still-works', async () => {
    // Regression: /permission workspace-write still exits a guarded session
    // whose host value is already workspace-write (no knob event is emitted).
    const before = (await permissions()).find((s) => s.sessionId === sessionId);
    const submission = await submitCommand(cdp, '/permission workspace-write', commands);
    await sleep(1200);
    const after = (await permissions()).find((s) => s.sessionId === sessionId);
    const payload = {
      submission,
      before: before?.effective,
      after: after?.effective,
      newEvents: after?.timeline.slice(before?.timeline.length ?? 0) ?? [],
    };
    await writeFile(out('f2-03-same-value.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('other-presets-still-work', async () => {
    const results = [];
    for (const preset of ['read-only', 'danger-full-access', 'workspace-write']) {
      const submission = await submitCommand(cdp, `/permission ${preset}`, commands);
      await sleep(1200);
      const list = await permissions();
      const target = list.find((s) => s.sessionId === sessionId);
      results.push({ preset, submission: submission.args, effective: target?.effective, last: target?.permissionCommands.at(-1) });
    }
    await writeFile(out('f2-04-other-presets.json'), JSON.stringify(results, null, 2));
    return results;
  });

  await step('auto-still-rejected-after-switches', async () => {
    const p = await runAuto('05-after-switches');
    return p;
  });

  await step('failed-command-keeps-state', async () => {
    // An unknown preset fails inside the host's own handler: the session must
    // keep its current permission facts and must not be treated as an exit.
    const before = (await permissions()).find((s) => s.sessionId === sessionId);
    const submission = await submitCommand(cdp, '/permission not-a-preset', commands);
    await sleep(1200);
    const after = (await permissions()).find((s) => s.sessionId === sessionId);
    const payload = { submission, before: before?.effective, after: after?.effective, last: after?.permissionCommands.at(-1) };
    await writeFile(out('f2-06-failed-command.json'), JSON.stringify(payload, null, 2));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f2-final.png')).catch(() => {});
  await writeFile(out('f2-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 3000));
}
