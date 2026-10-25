/**
 * F3 (uninstall): remove the bundle through the plugin page's own uninstall
 * action, which calls `pluginManager.removeBundle(name)` -> `pnpm remove`.
 *
 * Distinct from disable: uninstall removes the profile dependency and the
 * bundle selection, so a restart cannot bring the plugin back.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { boot } from './host.mjs';
import { evaluate, shot, waitFor } from './cdp.mjs';
import { openBrowser } from './browser.mjs';
import { dismissOverlays } from './ui.mjs';
import { readSessions, effectivePermission, permissionTimeline } from './session-log.mjs';
import { sendMessage, sleep } from './drive.mjs';

const caseDir = process.argv[2];
const port = Number(process.argv[3] ?? 57901);
await mkdir(caseDir, { recursive: true });
const steps = [];
const step = async (name, fn) => {
  const started = Date.now();
  try { const v = await fn(); steps.push({ name, ok: true, ms: Date.now() - started, value: v }); return v; }
  catch (error) { steps.push({ name, ok: false, ms: Date.now() - started, error: String(error?.stack ?? error) }); throw error; }
};
const out = (n) => join(caseDir, n);

let host = await boot(caseDir, port, {
  rules: [{ id: 'f3u-allow', match: { node: 'command', kind: 'regex', pattern: '^printf' }, verdict: 'allow' }],
});
let browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
let cdp = browser.cdp;
const openUi = async () => {
  await cdp.send('Page.navigate', { url: host.handle.origin + '/' });
  await waitFor(cdp, `document.querySelector('[contenteditable="true"]') !== null`, 40000);
  await dismissOverlays(cdp);
};
await openUi();

const sessions = async (h = host.handle) => (await readSessions(h.home))
  .filter((s) => s.events.some((e) => e.type === 'turn/start' || e.type === 'turn/end'))
  .sort((a, b) => (a.header?.createdAt ?? 0) - (b.header?.createdAt ?? 0));
const arbiterState = async () => evaluate(cdp, `fetch('/api/arbiter/state', { credentials: 'include' }).then(async r => ({ status: r.status })).catch(() => ({ status: 0 }))`);
const profileManifest = async () => JSON.parse(await readFile(join(host.handle.home, 'profiles/arb/package.json'), 'utf8'));

try {
  const sessionId = await step('session', async () => {
    await sendMessage(cdp, 'F3U bootstrap');
    for (let i = 0; i < 120; i += 1) {
      const done = (await sessions()).find((s) => s.events.some((e) => e.type === 'turn/end'));
      if (done !== undefined) return done.sessionId;
      await sleep(400);
    }
    throw new Error('no session');
  });

  await step('inflight-review-then-uninstall', async () => {
    // Start a call whose reviewer stays pending for 12s, then uninstall while
    // the gate is inside that review.
    await sendMessage(cdp, 'F3SLOW');
    for (let i = 0; i < 80; i += 1) {
      const log = await readFile(join(caseDir, 'reviewer-requests.jsonl'), 'utf8').catch(() => '');
      if (log.trim() !== '') break;
      await sleep(250);
    }
    const t0 = Date.now();
    await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); b?.click(); return true; })()`);
    await waitFor(cdp, `document.body.innerText.includes('dsh-arbiter')`, 25000);
    await sleep(600);
    await evaluate(cdp, `(() => { const row=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??'')==='查看 dsh-arbiter'); row?.click(); return true; })()`);
    await sleep(1200);
    const clicked = await evaluate(cdp, `(() => { const btn=[...document.querySelectorAll('button')].find(b=>(b.getAttribute('aria-label')??'')==='卸载 dsh-arbiter'); if(!btn) return false; btn.click(); return true; })()`);
    await sleep(800);
    const confirmed = await evaluate(cdp, `(() => {
      const dialogs=[...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
      const scope=dialogs.at(-1) ?? document;
      const hit=[...scope.querySelectorAll('button')].find(b=>(b.innerText??'').trim()==='卸载');
      if(!hit) return false; hit.click(); return true;
    })()`);
    const tUninstall = Date.now();
    await sleep(14000);
    const session = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      clicked, confirmed,
      timeline: { t0, tUninstall, deltaMs: tUninstall - t0 },
      decisions: (session?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, result: e.data?.result, trace: e.data?.trace })),
      results: (session?.events ?? []).filter((e) => e.type === 'tool/result').map((e) => ({ seq: e.seq, isError: e.data?.message?.isError === true, text: (e.data?.message?.content ?? []).map((c) => c.text ?? '').join('').slice(0, 200) })),
      effective: effectivePermission(session?.events ?? []),
      timelineTail: permissionTimeline(session?.events ?? []).slice(-8),
      marker: await readFile(join(host.handle.workspace, 'f3ui-slow.txt'), 'utf8').catch(() => null),
      arbiterRoute: (await arbiterState()).status,
    };
    await writeFile(out('f3u-06-inflight.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3u-06-inflight.png'));
    return payload;
  });

  await step('before-uninstall', async () => {
    const s = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = { effective: effectivePermission(s.events), manifest: await profileManifest(), state: (await arbiterState()).status };
    await writeFile(out('f3u-01-before.json'), JSON.stringify(payload, null, 2));
    return payload;
  });

  await step('uninstall-through-plugin-page', async () => {
    await evaluate(cdp, `(() => { const b=[...document.querySelectorAll('button')].find(x=>(x.getAttribute('aria-label')??'')==='插件'); b?.click(); return true; })()`);
    await waitFor(cdp, `document.body.innerText.includes('dsh-arbiter')`, 25000);
    await sleep(800);
    // Open the bundle detail, then use its uninstall action.
    const opened = await evaluate(cdp, `(() => {
      const row = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '') === '查看 dsh-arbiter');
      if (row) { row.click(); return 'detail'; }
      return 'none';
    })()`);
    await sleep(1500);
    const menu = await evaluate(cdp, `(() => {
      const labels = [...document.querySelectorAll('button')].map(b => b.getAttribute('aria-label')).filter(Boolean);
      return labels.filter(l => /卸载|移除|remove|uninstall/i.test(l));
    })()`);
    await writeFile(out('f3u-02-controls.json'), JSON.stringify({ opened, menu }, null, 2));
    await shot(cdp, out('f3u-02-detail.png'));
    return { opened, menu };
  });

  await step('click-uninstall', async () => {
    const clicked = await evaluate(cdp, `(() => {
      const btn = [...document.querySelectorAll('button')].find(b => (b.getAttribute('aria-label') ?? '') === '卸载 dsh-arbiter');
      if (!btn) return { ok: false };
      btn.click();
      return { ok: true };
    })()`);
    await sleep(800);
    // The manager opens a confirmation dialog. Target the dialog's own button,
    // not the toolbar action that shares the same label.
    const confirmed = await evaluate(cdp, `(() => {
      const dialogs = [...document.querySelectorAll('[role="dialog"], [role="alertdialog"]')];
      const scope = dialogs.length > 0 ? dialogs[dialogs.length - 1] : null;
      const buttons = [...(scope ?? document).querySelectorAll('button, [role="button"]')];
      const exact = buttons.find(b => (b.innerText ?? '').trim() === '卸载');
      const fallback = buttons.find(b => /^(确认|移除|继续|Remove|Uninstall)$/u.test((b.innerText ?? '').trim()));
      const hit = exact ?? fallback;
      if (!hit) return { ok: false, inDialog: scope !== null, seen: buttons.map(b => (b.innerText ?? '').trim()).filter(Boolean).slice(0, 8) };
      hit.click();
      return { ok: true, inDialog: scope !== null, label: (hit.innerText ?? '').trim() };
    })()`);
    await writeFile(out('f3u-03-confirm.json'), JSON.stringify({ clicked, confirmed }, null, 2));
    await shot(cdp, out('f3u-03-confirmed.png'));
    return { clicked, confirmed };
  });

  await step('wait-for-removal', async () => {
    // `pnpm remove` plus a reload; the plugin route disappears when the row is gone.
    let gone = false;
    for (let i = 0; i < 180; i += 1) {
      const state = await arbiterState();
      if (state.status === 404) { gone = true; break; }
      await sleep(1000);
    }
    await sleep(2000);
    const manifest = await profileManifest();
    const session = (await sessions()).find((x) => x.sessionId === sessionId);
    const payload = {
      gone,
      manifest,
      stillSelected: manifest.dsh?.profile?.bundles?.includes('dsh-arbiter') ?? null,
      stillDependency: manifest.dependencies?.['dsh-arbiter'] !== undefined,
      state: (await arbiterState()).status,
      effective: session === undefined ? null : effectivePermission(session.events),
      timelineTail: permissionTimeline(session?.events ?? []).slice(-6),
    };
    await writeFile(out('f3u-04-removed.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3u-04-removed.png'));
    return payload;
  });

  await step('restart-and-reopen-session', async () => {
    // After uninstall the profile no longer selects the bundle, so a restart
    // must not resurrect it, and the stored session must still load.
    await browser.close();
    await host.stop('SIGTERM');
    // Keep the profile exactly as the manager left it (the bundle removed).
    host = await boot(caseDir, port, { reuseProfile: true });
    browser = await openBrowser(caseDir, port + 100, { cookie: host.handle });
    cdp = browser.cdp;
    await openUi();
    await sleep(2000);
    // Reopen the stored session by id through the host's own route.
    const opened = await evaluate(cdp, `(async () => {
      const r = await fetch('/api/arbiter/state', { credentials: 'include' });
      return r.status;
    })()`);
    const list = await sessions();
    const target = list.find((x) => x.sessionId === sessionId);
    const payload = {
      arbiterRoute: opened,
      bundles: (await profileManifest()).dsh?.profile?.bundles ?? null,
      sessionLoaded: target !== undefined,
      sessionEvents: target?.events.length ?? 0,
      decisions: (target?.events ?? []).filter((e) => e.type === 'plugin:arbiter/decision').map((e) => ({ seq: e.seq, ignorable: e.ignorable, result: e.data?.result })),
      effective: target === undefined ? null : effectivePermission(target.events),
      selectorText: await evaluate(cdp, `(() => { const c=[...document.querySelectorAll('[data-slot="conversation.input.permission"]')].filter(e=>e.isConnected); return c[0]?.innerText ?? null; })()`),
    };
    await writeFile(out('f3u-05-after-restart.json'), JSON.stringify(payload, null, 2));
    await shot(cdp, out('f3u-05-after-restart.png'));
    return payload;
  });
} catch (error) {
  steps.push({ name: 'fatal', ok: false, error: String(error?.stack ?? error) });
} finally {
  await shot(cdp, out('f3u-final.png')).catch(() => {});
  await writeFile(out('f3u-steps.json'), JSON.stringify(steps, null, 2));
  await browser.close();
  await host.stop();
  console.log(steps.map((s) => `${s.ok === false ? 'FAIL' : 'OK  '} ${s.name} ${s.ms ?? ''}`).join('\n'));
  const f = steps.filter((s) => s.ok === false);
  if (f.length) console.log(JSON.stringify(f, null, 2).slice(0, 1500));
}
