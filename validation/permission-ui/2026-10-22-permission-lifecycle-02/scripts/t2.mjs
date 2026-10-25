/**
 * T2: a new call arriving AFTER stop-admission but BEFORE rollback.
 *
 * This is the window the previous run could not reach. The sequence is:
 *
 *   1. session A issues a call whose review the fixture HOLDS (barrier);
 *      its gate is therefore active, and A is a managed session.
 *   2. session B is warmed up first, so it is managed before the action.
 *   3. the plugin is disabled through the real plugin page switch. The
 *      disposer sets accepting=false and then waits for `active` to drain —
 *      which cannot finish while A's review is held. That is a long,
 *      deterministic stop-admission window.
 *   4. inside that window, a new call is submitted in session B.
 *   5. only then is A's review released.
 *
 * Deployment is trusted (danger-full-access) so a call that runs under the
 * stale permission is visible as a write outside the workspace.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionTimeline } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';
import { waitStarted, release, waitFinished, barrierTimeline, isHeld } from './barrier.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 58031);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port, {
  mode: 'trusted',
  // Warm-up calls must not enter the reviewer: only the calls under test are
  // meant to be held by the barrier.
  rules: [
    { id: 't2-warmup', match: { node: 'command', kind: 'regex', pattern: "^printf 'T2-WARM" }, verdict: 'allow' },
  ],
});
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
const marker = (p) => readFile(p, 'utf8').then((c) => c.trim()).catch(() => null);

/** Poll the plugin's lifecycle trace until `match` appears. */
const waitForTrace = async (dir, match, timeoutMs = 60000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const events = await trace();
    const hit = events.find((e) => (typeof match === 'string' ? e.event === match : match(e)));
    if (hit !== undefined) return hit;
    await sleep(50);
  }
  return null;
};
const managerState = () => evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(r => ({ status: r.status })).catch(() => ({ status: 0 }))`);
const composer = async () => {
  const ok = await evaluate(cdp, `document.querySelector('[contenteditable="true"]') !== null`);
  if (ok !== true) {
    await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
    await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 30000);
    await dismissOverlays(cdp);
    await sleep(500);
  }
};
const newSession = async () => {
  await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='新建会话'); b?.click(); return b!==undefined; })()`);
  await sleep(2500);
  await dismissOverlays(cdp);
};
/** Switch to a session by clicking its row in the sidebar list. */
const switchToSession = async (titleFragment) => {
  await evaluate(cdp, `(() => {
    const rail=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='打开侧边栏');
    if (rail) { rail.click(); return true; }
    return false;
  })()`);
  await sleep(1200);
  const clicked = await evaluate(cdp, `(() => {
    const rows=[...document.querySelectorAll('[data-slot="sidebar"] *')].filter((e)=>{
      const t=(e.innerText??'').trim();
      return t.length>0 && t.includes(${JSON.stringify(titleFragment)}) && e.querySelectorAll('*').length < 12;
    });
    const hit=rows.at(-1);
    if (!hit) return { ok:false, seen:[...document.querySelectorAll('[data-slot="sidebar"] *')].map(e=>(e.innerText??'').trim()).filter(t=>t && t.length<40).slice(0,10) };
    hit.click();
    return { ok:true, text:(hit.innerText??'').trim().slice(0,60) };
  })()`);
  await sleep(2000);
  await dismissOverlays(cdp);
  return clicked;
};

const openPluginPage = async () => {
  await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); b?.click(); return true; })()`);
  await waitFor(cdp, `[...document.querySelectorAll('button[role="switch"]')].some(b => (b.getAttribute('aria-label') ?? '').includes('dsh-arbiter'))`, 20000);
};
const toggleOff = () => evaluate(cdp, `(() => { const sw=[...document.querySelectorAll('button[role="switch"]')].find(b=>(b.getAttribute('aria-label')??'').includes('dsh-arbiter')); if(!sw) return {ok:false}; sw.click(); return {ok:true,before:sw.getAttribute('aria-checked')}; })()`);

try {
  let sessionA = await step('session-a', async () => {
    await sendMessage(cdp, 'T2-WARM bootstrap');
    for (let i = 0; i < 150; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session A');
  });

  const sessionB = await step('session-b-managed', async () => {
    await newSession();
    await sendMessage(cdp, 'T2-WARM session-b');
    for (let i = 0; i < 150; i += 1) {
      const list = await sessions();
      const other = list.find(
        (s) => s.sessionId !== sessionA && s.events.some((e) => e.type === 'turn/end' && e.data?.turn === 1),
      ) ?? list.find((s) => s.sessionId !== sessionA && s.events.some((e) => e.type === 'turn/end'));
      if (other !== undefined) return other.sessionId;
      await sleep(400);
    }
    const list = await sessions();
    throw new Error(`no session B; saw ${list.map((s) => s.sessionId.slice(-8) + ':' + s.events.length).join(',')}`);
  });

  // Re-identify A: the sidebar's "new session" may have reused the first
  // shell, so A is whichever session is not B.
  sessionA = (await sessions()).find((s) => s.sessionId !== sessionB)?.sessionId ?? sessionA;

  await step('session-b-is-managed', async () => {
    // B must have been taken over by arbiter BEFORE the lifecycle action, so a
    // call there exercises the rollback path rather than a never-managed
    // control session.
    const traceEvents = await trace();
    const managed = traceEvents.filter((e) => e.event === 'gate/entered' && e.sessionId === sessionB);
    if (managed.length === 0) throw new Error('session B was never gated by arbiter');
    return { managedCalls: managed.length, firstAt: managed[0].at };
  });

  await step('stop-admission-then-new-call', async () => {
    // 1. session A issues a call whose review the fixture holds.
    await switchToSession('T2-WARM bootstrap');
    await composer();
    await sendMessage(cdp, 'T2OLD');
    const started = await waitStarted(caseDir, 1, 40000);
    const heldCall = started[0]?.callId;
    if (heldCall === undefined) throw new Error('review never started');
    const heldBefore = isHeld(caseDir, heldCall);

    // 2. Click the manager switch. This is only the *request*; the disposer
    //    runs later. Nothing may be concluded from this timestamp.
    await openPluginPage();
    const toggled = await toggleOff();
    const tClick = Date.now();

    // 3. Wait for the plugin's own `unload/stop-admission` record. Only then is
    //    the stop-admission window actually open, and it stays open because the
    //    disposer is blocked waiting for A's held review.
    const stop = await waitForTrace(caseDir, 'unload/stop-admission', 60000);
    if (stop === null) throw new Error('unload/stop-admission never recorded');
    const tStop = stop.at;

    // 4. The new call, submitted strictly inside the window, in the *other*
    //    (already-managed) session.
    await switchToSession('T2-WARM session-b');
    await composer();
    const tNew = Date.now();
    await sendMessage(cdp, 'T2NEW');

    // 5. Give the host time to route that turn into tools/pre-execute, while
    //    the disposer is still blocked on A.
    const newGate = await waitForTrace(
      caseDir,
      (e) =>
        (e.event === 'gate/skipped' || e.event === 'gate/entered') &&
        e.sessionId === sessionB &&
        e.at >= tStop,
      20000,
    );
    const tNewGate = newGate?.at ?? null;

    // 6. Release A's review; the drain can now finish.
    const tRelease = Date.now();
    release(caseDir, heldCall);
    const finished = await waitFinished(caseDir, heldCall, 40000);
    const drained = await waitForTrace(caseDir, 'unload/drained', 40000);
    const rolled = await waitForTrace(caseDir, 'unload/release', 40000);

    await sleep(6000);
    const traceEvents = await trace();
    const list = await sessions();
    const payload = {
      heldCall, heldBefore, toggled,
      overlap: {
        tClick, tStop, tNew, tNewGate, tRelease,
        stopAfterClickMs: tStop - tClick,
        newAfterStopMs: tNew - tStop,
        newGateAfterStopMs: tNewGate === null ? null : tNewGate - tStop,
        releaseAfterNewGateMs: tNewGate === null ? null : tRelease - tNewGate,
        drainedAt: drained?.at ?? null,
        releaseAt: rolled?.at ?? null,
      },
      stopActive: stop.active,
      finished: finished !== null,
      barrier: barrierTimeline(caseDir),
      trace: traceEvents,
      markers: {
        oldInside: await marker(join(host.handle.workspace, 't2-old.txt')),
        newOutside: await marker(join(host.handle.outside, 't2-new.txt')),
      },
      manager: await managerState(),
      sessions: list.map((s) => ({
        sessionId: s.sessionId,
        effective: effectivePermission(s.events),
        results: s.events.filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 240) })),
        decisions: s.events.filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result })),
      })),
      sessionA, sessionB,
    };
    await writeFile(out('t2-01-window.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('t2-01-window.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('t2-final.png')).catch(() => {});
  await writeFile(out('t2-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const f = steps.filter((s) => s.ok === false);
  if (f.length) console.log(JSON.stringify(f, null, 2).slice(0, 1500));
}
