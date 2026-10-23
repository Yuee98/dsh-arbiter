/**
 * F5: a real human answers an approval that arbiter opened.
 *
 * The driver opens the approval, waits for a real operator to click, then
 * records what the host logged and whether the tool ran. Nothing here clicks
 * on the operator's behalf: if no answer arrives in the window, the case is
 * reported as not completed rather than simulated.
 *
 * Run with:
 *   node scripts/f5.mjs <caseDir> <port> [--wait-seconds 180]
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57841);
const waitIndex = process.argv.indexOf('--wait-seconds');
const waitSeconds = waitIndex === -1 ? 180 : Number(process.argv[waitIndex + 1] ?? 180);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

const host = await boot(caseDir, port);
const browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
const cdp = browser.cdp;
await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
await dismissOverlays(cdp);

const sessions = async () => (await readSessions(host.handle.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F5 bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('open-human-approval', async () => {
    await sendMessage(cdp, 'F5ASK');
    let asked = null;
    for (let i = 0; i < 160; i += 1) {
      const s = (await sessions()).find((x) => x.sessionId === sessionId);
      const ev = s?.events.find((e) => e.type === 'approval/asked');
      if (ev !== undefined) { asked = { seq: ev.seq, data: ev.data }; break; }
      await sleep(400);
    }
    await shot(cdp, out('f5-01-approval-open.png'));
    await writeFile(out('f5-01-asked.json'), JSON.stringify({ asked, effective: (await sessions()).find((s) => s.sessionId === sessionId) ? effectivePermission((await sessions()).find((s) => s.sessionId === sessionId).events) : null }, null, 2));
    return asked;
  });

  await step('await-real-human', async () => {
    // No automation clicks here. The operator answers in the visible window.
    const deadline = Date.now() + waitSeconds * 1000;
    let decided = null;
    while (Date.now() < deadline) {
      const s = (await sessions()).find((x) => x.sessionId === sessionId);
      const ev = s?.events.find((e) => e.type === 'approval/decided');
      if (ev !== undefined) { decided = { seq: ev.seq, outcome: ev.data?.outcome }; break; }
      await sleep(1000);
    }
    await shot(cdp, out('f5-02-after-answer.png'));
    await writeFile(out('f5-02-decided.json'), JSON.stringify({ decided, waitedSeconds: waitSeconds }, null, 2));
    return decided;
  });

  await step('settle-and-record', async () => {
    await sleep(4000);
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      decisions: (s?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace, ignorable: e.ignorable })),
      approvals: (s?.events ?? []).filter((e) => e.type.startsWith('approval/')).map((e) => ({ seq: e.seq, type: e.type, data: e.data })),
      results: (s?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 200) })),
      marker: await import('node:fs/promises').then((fs) => fs.readFile(join(host.handle.workspace, 'f5-ask.txt'), 'utf8').catch(() => null)),
    };
    await writeFile(out('f5-03-record.json'), JSON.stringify(payload, null, 2));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f5-final.png')).catch(() => {});
  await writeFile(out('f5-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
}
