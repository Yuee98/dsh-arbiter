/**
 * Own the headless browser for one driver: start it, connect, and close it.
 *
 * A per-run user-data-dir keeps cookies and caches inside the run directory and
 * avoids the daily browser profile entirely.
 */
import { spawn } from 'node:child_process';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { connect, setCookie } from './cdp.mjs';

const EDGE = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge';

export async function openBrowser(caseDir, port, { cookie } = {}) {
  const profileDir = join(caseDir, 'edge-profile');
  await mkdir(profileDir, { recursive: true });
  const child = spawn(EDGE, [
    '--headless=new', '--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage',
    '--disable-crash-reporter', '--no-first-run', '--disable-extensions',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profileDir}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c) => { stderr += c; });

  for (let i = 0; i < 120; i += 1) {
    try {
      const version = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      if (version.Browser !== undefined) break;
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 200));
  }

  const cdp = await connect(port);
  if (cookie !== undefined) await setCookie(cdp, cookie.origin, cookie.cookie);
  return {
    cdp,
    stderr: () => stderr,
    close: async () => {
      try { cdp.close(); } catch {}
      try { child.kill('SIGTERM'); } catch {}
      await new Promise((r) => setTimeout(r, 400));
      try { child.kill('SIGKILL'); } catch {}
      await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
