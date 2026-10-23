/**
 * T7: two tool calls from the SAME session inside the same step.
 *
 * The host schedules a step's tool calls through a pool
 * (`maxParallelToolCalls`, default 10) and only runs a second call
 * concurrently when `isConcurrencySafe(args) === true`. `read` declares that,
 * so two `read` calls in one step both enter `tools/pre-execute` before either
 * finishes.
 *
 * The fixture holds the review of the SECOND read. That makes the gate entry of
 * the first call and the pending review of the second overlap in time, which is
 * the arrangement this case needs to observe.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';
import { waitStarted, release, waitFinished, barrierTimeline, isHeld } from './barrier.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 58721);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, { mode: 'trusted' });
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const trace = async () => readFile(join(caseDir, 'arbiter-trace.jsonl'), 'utf8')
  .then((t) => t.split('\n').filter(Boolean).map((l) => JSON.parse(l)))
  .catch(() => []);
const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'T7 bootstrap');
    for (let i = 0; i < 150; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('two-parallel-reads-one-held', async () => {
    await sendMessage(cdp, 'T7PAR');
    // Two reviews start here; only the one matching holdMatch is actually held.
    const started = await waitStarted(caseDir, 2, 40000);
    const heldCall = started.map((r) => r.callId).find((id) => isHeld(caseDir, id));
    if (heldCall === undefined) {
      throw new Error(`no held review; started=${started.map((r) => r.callId).join(',')}`);
    }

    // While the second read's review is held, the first read must already have
    // entered the gate. Check the trace for two gate entries in one step.
    await sleep(600);
    const during = await trace();
    const gates = during.filter((e) => e.event === 'gate/entered');
    const reviews = during.filter((e) => e.event === 'review/start');

    release(caseDir, heldCall);
    await waitFinished(caseDir, heldCall, 30000);
    // Wait for the turn to actually finish, so both results are committed.
    for (let i = 0; i < 120; i += 1) {
      const s = (await sessions()).find((x) => x.sessionId === sessionId);
      const ended = (s?.events ?? []).some((e) => e.type === 'turn/end' && e.data?.turn === 2);
      if (ended) break;
      await sleep(500);
    }
    await sleep(1000);

    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      heldCall,
      gateEntriesWhileHeld: gates.length,
      reviewsWhileHeld: reviews.length,
      concurrent: gates.length >= 2,
      barrier: barrierTimeline(caseDir),
      trace: await trace(),
      toolCalls: (s?.events ?? []).filter((e) => e.type === 'tool/call').map((e) => ({ seq: e.seq, step: e.data?.step, name: e.data?.name, callId: e.data?.callId })),
      toolResults: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ seq: e.seq, callId: e.data?.toolCallId, isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 160) })),
      decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, callId: e.data?.callId, result: e.data?.result })),
      bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-400),
    };
    await writeFile(out('t7-01-parallel.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('t7-01-parallel.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await writeFile(out('t7-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const f = steps.filter((s) => s.ok === false);
  if (f.length) console.log(JSON.stringify(f, null, 2).slice(0, 1200));
}
