/**
 * F1: real cold recovery of a written decision record.
 *
 * Sequence: a real gate decision writes `plugin:arbiter/decision` through the
 * public `appendPluginRecord`, the session is closed, the host process exits,
 * a fresh host reopens the same session, and the record is read back. Then the
 * audit SQLite directory is moved away and the same reopen is repeated.
 *
 * This exercises the real plugin (linked profile), not a probe.
 */
import { mkdir, readdir, rename, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, permissionTimeline } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57721);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);
const sleepLong = (ms) => new Promise((r) => setTimeout(r, ms));

// A deterministic rule produces a decision without a reviewer round trip, so
// the record appears immediately and the cold restart is not racing a model.
const rules = [
  { id: 'f1-deny', match: { node: 'command', kind: 'exact', pattern: "printf 'F1 deny probe\n' > " }, verdict: 'deny', comment: 'F1 deterministic deny' },
];
let host = await boot(caseDir, port, { rules });
let browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
let cdp = browser.cdp;

const openUi = async () => {
  await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[data-slot="conversation.input.permission"]') !== null`, 40000);
  await dismissOverlays(cdp);
};
await openUi();

const decisions = async (home) => {
  const list = await readSessions(home);
  const found = [];
  for (const session of list) {
    for (const event of session.events) {
      if (event.type === 'plugin:arbiter/decision') {
        found.push({
          sessionId: session.sessionId,
          seq: event.seq,
          ignorable: event.ignorable === true,
          data: event.data,
        });
      }
    }
  }
  return found;
};
const nonIgnorablePluginEvents = async (home) => {
  const list = await readSessions(home);
  const bad = [];
  for (const session of list) {
    for (const event of session.events) {
      if (typeof event.type === 'string' && event.type.startsWith('plugin:') && event.ignorable !== true) {
        bad.push({ sessionId: session.sessionId, seq: event.seq, type: event.type });
      }
    }
  }
  return bad;
};

try {
  const sessionId = await step('produce-decision', async () => {
    await sendMessage(cdp, 'F1RESEARCH');
    let id = null;
    for (let i = 0; i < 150; i += 1) {
      const found = await decisions(host.handle.home);
      if (found.length > 0) { id = found[0].sessionId; break; }
      await sleep(400);
    }
    if (id === null) throw new Error('no arbiter decision record was written');
    // Wait for the turn to finish so the session is quiescent before closing.
    for (let i = 0; i < 150; i += 1) {
      const list = await readSessions(host.handle.home);
      const s = list.find((x) => x.sessionId === id);
      if (s?.events.some((e) => e.type === 'turn/end')) break;
      await sleep(400);
    }
    return id;
  });

  await step('record-written-ignorable', async () => {
    const found = await decisions(host.handle.home);
    const payload = {
      decisions: found.map((d) => ({ sessionId: d.sessionId, seq: d.seq, ignorable: d.ignorable, callId: d.data?.callId, tool: d.data?.tool, result: d.data?.result, trace: d.data?.trace })),
      nonIgnorablePluginEvents: await nonIgnorablePluginEvents(host.handle.home),
    };
    await writeFile(out('f1-01-written.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('close-session-and-exit-host', async () => {
    // Close the view (navigate away) and stop the whole host process.
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleepLong(800);
    await browser.close();
    const pid = host.handle.pid;
    await host.stop('SIGTERM');
    return { pid, stopped: true };
  });

  await step('cold-restart-and-reopen', async () => {
    host = await boot(caseDir, port, { rules });
    browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
    cdp = browser.cdp;
    await openUi();
    // Reopen the stored session through the host's own public resume path.
    const resumed = await evaluate(cdp, `(async () => {
      const response = await fetch('/api/arbiter/state', { credentials: 'include' });
      return { status: response.status };
    })()`);
    await sleepLong(1200);
    const reopened = await evaluate(cdp, `(async () => {
      const response = await fetch('/api/arbiter/state', { credentials: 'include' });
      const body = await response.json();
      return { ok: body.enabled !== undefined, sessionRecords: body.sessionRecords };
    })()`);
    const found = await decisions(host.handle.home);
    const payload = {
      resumed,
      state: reopened,
      decisionsAfterRestart: found.map((d) => ({ sessionId: d.sessionId, seq: d.seq, ignorable: d.ignorable, callId: d.data?.callId, tool: d.data?.tool, result: d.data?.result })),
      loadedSessions: (await readSessions(host.handle.home)).map((s) => ({ sessionId: s.sessionId, events: s.events.length })),
      nonIgnorablePluginEvents: await nonIgnorablePluginEvents(host.handle.home),
    };
    await writeFile(out('f1-02-cold-restart.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f1-02-cold-restart.png'));
    return payload;
  });

  await step('read-back-summary', async () => {
    // The plugin must read its own record back after the cold start: a new
    // gate decision sees the earlier call in its snapshot's prior history.
    const before = await decisions(host.handle.home);
    await sendMessage(cdp, 'F1ALLOW');
    for (let i = 0; i < 120; i += 1) {
      const now = await decisions(host.handle.home);
      if (now.length > before.length) break;
      await sleep(400);
    }
    const after = await decisions(host.handle.home);
    const payload = {
      before: before.length,
      after: after.length,
      records: after.map((d) => ({ seq: d.seq, callId: d.data?.callId, tool: d.data?.tool, result: d.data?.result, ignorable: d.ignorable })),
    };
    await writeFile(out('f1-03-read-back.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('audit-removed-cold-restart', async () => {
    // Move the audit directory away, restart again, reopen: the session must
    // still load and the decision records must still be readable.
    await browser.close();
    await host.stop('SIGTERM');
    const auditDir = join(host.handle.home, 'arbiter');
    const moved = join(caseDir, 'audit-moved-away');
    const hadAudit = existsSync(auditDir);
    if (hadAudit) await rename(auditDir, moved);
    host = await boot(caseDir, port, { rules });
    browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
    cdp = browser.cdp;
    await openUi();
    await sleepLong(1200);
    const found = await decisions(host.handle.home);
    const payload = {
      auditDirExisted: hadAudit,
      auditPresentNow: existsSync(join(host.handle.home, 'arbiter', 'arbiter.db')),
      decisions: found.map((d) => ({ sessionId: d.sessionId, seq: d.seq, ignorable: d.ignorable, callId: d.data?.callId })),
      nonIgnorablePluginEvents: await nonIgnorablePluginEvents(host.handle.home),
      state: await evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(r => r.json()).then(b => ({ enabled: b.enabled, audit: b.audit?.health?.state, sessionRecords: b.sessionRecords }))`),
    };
    await writeFile(out('f1-04-audit-removed.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f1-04-audit-removed.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f1-final.png')).catch(() => {});
  await writeFile(out('f1-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close().catch(() => {});
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const failed = steps.filter((s) => s.ok === false);
  if (failed.length > 0) console.log(JSON.stringify(failed, null, 2).slice(0, 3000));
}
