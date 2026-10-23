/**
 * F5: hand the pending approval to a real operator's own browser.
 *
 * The driver boots the isolated host, opens the session in its own headless
 * client (to submit the message that triggers the approval), and then prints
 * the host's token URL. The operator opens that URL in their normal browser —
 * the same server, the same session — and answers the approval there.
 *
 * The driver never clicks. It only waits for `approval/decided` in the session
 * log, then records the decision chain and the tool effect.
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
const port = Number(process.argv[3] ?? 57881);
const waitIndex = process.argv.indexOf('--wait-seconds');
const waitSeconds = waitIndex === -1 ? 1800 : Number(process.argv[waitIndex + 1] ?? 1800);
await mkdir(caseDir, { recursive: true });

const host = await boot(caseDir, port);
// The greeting URL carries the one-time token; the operator must open this one.
const tokenUrl = host.tokenUrl;
await writeFile(join(caseDir, 'operator-url.txt'), tokenUrl + '\n');

const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));

const steps = [];
try {
  await sendMessage(cdp, 'F5HUMAN approval probe');
  let sessionId = null;
  for (let i = 0; i < 120; i += 1) {
    const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
    if (done !== undefined) { sessionId = done.sessionId; break; }
    await sleep(400);
  }
  if (sessionId === null) throw new Error('no session');
  await sleep(1500);

  // Give the operator the session identity so they can pick the right row.
  const header = (await sessions()).find((s) => s.sessionId === sessionId)?.header;
  await writeFile(join(caseDir, 'operator-hint.json'), JSON.stringify({
    tokenUrl, sessionId, title: header?.title ?? null, cwd: header?.cwd ?? null,
  }, null, 2));

  process.stdout.write(`\n=== OPEN THIS IN YOUR BROWSER ===\n${tokenUrl}\n`);
  process.stdout.write(`session: ${header?.title ?? sessionId}\n\n`);

  await sendMessage(cdp, 'F5ASK');
  for (let i = 0; i < 240; i += 1) {
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    if (s?.events.some((e) => e.type === 'approval/asked')) break;
    await sleep(500);
  }
  process.stdout.write('approval is pending — answer it in your browser\n');
  await shot(cdp, join(caseDir, 'f5h-01-pending.png'));

  const deadline = Date.now() + waitSeconds * 1000;
  let decided = null;
  while (Date.now() < deadline) {
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const ev = s?.events.find((e) => e.type === 'approval/decided');
    if (ev !== undefined) { decided = { seq: ev.seq, outcome: ev.data?.outcome }; break; }
    await sleep(1000);
  }
  await sleep(3500);
  const s = (await sessions()).find((x) => x.sessionId === sessionId);
  const payload = {
    decided,
    waitedSeconds: waitSeconds,
    effective: effectivePermission(s?.events ?? []),
    approvals: (s?.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ seq: e.seq, type: e.type, data: e.data })),
    decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace, ignorable: e.ignorable })),
    results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 240) })),
    marker: await readFile(join(host.handle.workspace, 'f5-ask.txt'), 'utf8').catch(() => null),
    bodyTail: (await evaluate(cdp, 'document.body.innerText')).slice(-600),
  };
  await writeFile(join(caseDir, 'f5h-02-result.json'), JSON.stringify(payload, null, 2));
  await shot(cdp, join(caseDir, 'f5h-02-result.png'));
  steps.push({ name: 'human-approval', ok: decided !== null, value: payload });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await writeFile(join(caseDir, 'f5h-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  const s = steps[0];
  console.log(s?.ok ? `OK human-approval ${JSON.stringify(s.value.decided)}` : `FAIL ${s?.error ?? 'unknown'}`);
}
