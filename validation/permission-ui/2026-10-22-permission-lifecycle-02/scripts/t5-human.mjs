/**
 * T5 (human half): switch while an approval is pending, then let a real
 * operator answer it.
 *
 * Order:
 *   1. open an approval and stop;
 *   2. drive the public command channel to a DIFFERENT preset (read-only);
 *   3. print the host token URL and wait for a human to click;
 *   4. record the settlement chain and the tool effect.
 *
 * The driver never clicks in the approval. It only issues the command.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 58661);
const waitIndex = process.argv.indexOf('--wait-seconds');
const waitSeconds = waitIndex === -1 ? 1800 : Number(process.argv[waitIndex + 1] ?? 1800);
await mkdir(caseDir, { recursive: true });

const host = await boot(caseDir, port, { bridge: true });
await writeFile(join(caseDir, 'operator-url.txt'), host.tokenUrl + '\n');
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);
await waitFor(cdp, `typeof window.__dshCommand === 'object'`, 30000);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const view = async (id) => (await sessions()).find((s) => s.sessionId === id);
const pending = (s) => (s?.events ?? []).some((e) => e.type === 'approval/asked')
  && !(s?.events ?? []).some((e) => e.type === 'approval/decided');

const steps = [];
try {
  await sendMessage(cdp, 'T5H bootstrap');
  let sessionId = null;
  for (let i = 0; i < 150; i += 1) {
    const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
    if (done !== undefined) { sessionId = done.sessionId; break; }
    await sleep(400);
  }
  if (sessionId === null) throw new Error('no session');

  await sendMessage(cdp, 'T5ASK');
  for (let i = 0; i < 240; i += 1) {
    if (pending(await view(sessionId))) break;
    await sleep(500);
  }

  const before = await view(sessionId);
  process.stdout.write(`\n=== OPEN THIS IN YOUR BROWSER ===\n${host.tokenUrl}\n`);
  process.stdout.write('approval is pending; the driver will now switch to read-only\n');
  const switched = await evaluate(cdp, `window.__dshCommand.call(${JSON.stringify(sessionId)}, '/permission read-only')`);
  await sleep(2500);
  const after = await view(sessionId);
  await writeFile(join(caseDir, 't5h-01-switched.json'), JSON.stringify({
    before: { effective: effectivePermission(before.events), pending: pending(before) },
    switched,
    after: { effective: effectivePermission(after.events), pending: pending(after) },
  }, null, 2));

  process.stdout.write('now click 允许一次 or 拒绝 in your browser\n');
  const deadline = Date.now() + waitSeconds * 1000;
  let decided = null;
  while (Date.now() < deadline) {
    const s = await view(sessionId);
    const ev = s?.events.find((e) => e.type === 'approval/decided');
    if (ev !== undefined) { decided = { seq: ev.seq, outcome: ev.data?.outcome }; break; }
    await sleep(1000);
  }
  await sleep(3500);
  const s = await view(sessionId);
  const payload = {
    decided,
    effective: effectivePermission(s?.events ?? []),
    approvals: (s?.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ seq: e.seq, type: e.type, outcome: e.data?.outcome ?? null })),
    decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace })),
    commands: (s?.events ?? []).filter((e) => e.type.startsWith('command/')).map((e) => ({ seq: e.seq, type: e.type, args: e.data?.args, kind: e.data?.kind })),
    results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 220) })),
    marker: await readFile(join(host.handle.workspace, 't5-ask.txt'), 'utf8').catch(() => null),
  };
  await writeFile(join(caseDir, 't5h-02-result.json'), JSON.stringify(payload, null, 2));
  await shot(cdp, join(caseDir, 't5h-02-result.png'));
  steps.push({ name: 'human-after-switch', ok: decided !== null, value: payload });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await writeFile(join(caseDir, 't5h-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps[0]?.ok ? `OK ${JSON.stringify(steps[0].value.decided)}` : `FAIL ${steps[0]?.error ?? ''}`);
}
