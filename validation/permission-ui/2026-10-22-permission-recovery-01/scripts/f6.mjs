/**
 * F6: host cancellation of a running PTC (`run_code`) when the sandbox changes.
 *
 * Sequence: start in trusted (danger-full-access), begin a real `run_code`
 * whose inner `tools.bash` is held by a slow review, then switch the session
 * to workspace-write through the host's own `/permission` command. The outer
 * and inner signals, the tool result and the files on disk are all recorded.
 *
 * A late allow must not run the body; already-produced effects stay as they are.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionTimeline, permissionCommands } from './session-log.mjs';
import { sendMessage, submitCommand, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57861);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, { mode: 'trusted', env: { DSH_TOOLS_MODE: 'ptc' } });
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const view = async (id) => {
  const s = (await sessions()).find((x) => x.sessionId === id);
  return s;
};
const marker = (name) => readFile(join(host.handle.workspace, name), 'utf8').then((c) => c.trim()).catch(() => null);

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F6 bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('baseline-trusted', async () => {
    const s = await view(sessionId);
    const payload = { effective: effectivePermission(s.events), header: s.header };
    await writeFile(out('f6-00-baseline.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('start-ptc-then-switch', async () => {
    // 1. start the real run_code; its inner bash blocks in the slow review
    await sendMessage(cdp, 'F6PTC');
    let sawOuter = false;
    for (let i = 0; i < 120; i += 1) {
      const s = await view(sessionId);
      if (s?.events.some((e) => e.type === 'tool/call' && e.data?.name === 'run_code')) { sawOuter = true; break; }
      await sleep(300);
    }
    // 2. the review request has been issued: the inner call is parked
    for (let i = 0; i < 120; i += 1) {
      const log = await readFile(join(caseDir, 'reviewer-requests.jsonl'), 'utf8').catch(() => '');
      if (log.trim() !== '') break;
      await sleep(250);
    }
    const outerStarted = await marker('f6-outer-started.txt');
    // 3. switch the sandbox while the inner call waits for its review
    const commands = async () => {
      const list = await sessions();
      return list.flatMap((s) => permissionCommands(s.events).map((c) => ({ ...c, sessionId: s.sessionId })));
    };
    const submission = await submitCommand(cdp, '/permission workspace-write', commands);
    await sleep(4000);
    const mid = await view(sessionId);
    const payload = {
      sawOuter, submission, outerStarted,
      mid: {
        effective: effectivePermission(mid?.events ?? []),
        calls: (mid?.events ?? []).filter((e) => e.type === 'tool/call').map((e) => ({ seq: e.seq, name: e.data?.name, callId: e.data?.callId })),
        results: (mid?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ seq: e.seq, isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 300) })),
      },
      markers: { outerStarted: await marker('f6-outer-started.txt'), inner: await marker('f6-inner.txt'), outerFinished: await marker('f6-outer-finished.txt') },
    };
    await writeFile(out('f6-01-switch.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f6-01-switch.png'));
    return payload;
  });

  await step('settle-after-late-review', async () => {
    // Let the 10s review elapse; a late allow must not execute the body.
    await sleep(14000);
    const s = await view(sessionId);
    const payload = {
      effective: effectivePermission(s?.events ?? []),
      timeline: permissionTimeline(s?.events ?? []).slice(-10),
      calls: (s?.events ?? []).filter((e) => e.type === 'tool/call').map((e) => ({ seq: e.seq, name: e.data?.name, callId: e.data?.callId, at: e.time })),
      results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ seq: e.seq, at: e.time, isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 400) })),
      decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace })),
      markers: { outerStarted: await marker('f6-outer-started.txt'), inner: await marker('f6-inner.txt'), outerFinished: await marker('f6-outer-finished.txt') },
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-900),
    };
    await writeFile(out('f6-02-settled.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f6-02-settled.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f6-final.png')).catch(() => {});
  await writeFile(out('f6-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length) console.log(JSON.stringify(failed, null, 2).slice(0, 2500));
}
