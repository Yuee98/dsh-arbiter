/** Boot one isolated host; the child dies with the driver. */
import { spawn } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DSH, CLI, isolatedEnv, makeProfile, prepareCase } from './env.mjs';

export async function boot(caseDirArg, port, options = {}) {
  const prepared = await prepareCase(caseDirArg);
  const { home, workspace, scenarioPath, dir } = prepared;
  // `reuseProfile` keeps whatever the plugin manager wrote: needed to observe
  // an uninstall surviving a restart instead of rebuilding the profile.
  if (options.reuseProfile !== true) await makeProfile({
    home,
    scenario: scenarioPath,
    workspace,
    // `mode: 'trusted'` only changes the deployment default; the arbiter
    // "trusted boundary" is a plugin-config value applied by the plugin.
    patchRows: [
      { id: 'arbiter', name: 'dsh-arbiter', config: {
        enabled: true,
        rules: options.rules ?? [],
        reviewer: { type: 'chat', chat: { provider: 'pui', model: 'fixture-1', temperature: 0, maxTokens: 400, timeoutMs: 20000, maxRepairRetries: 1 } },
      } },
      ...(options.patchRows ?? []),
    ],
    sandboxMode: options.mode === 'trusted' ? 'danger-full-access' : 'workspace-write',
    // The case's own directory stands in for `<Documents>`; the host then
    // never shells out to `osascript` for it.
    documentsDirectory: options.documentsDirectory ?? prepared.dir,
    bundles: options.bundles,
    linkPlugin: options.linkPlugin !== false,
  });
  const child = spawn(DSH, ['--expose-internals', CLI, '--profile', 'arb', '--no-open', '--port', String(port)], {
    cwd: workspace,
    env: isolatedEnv(home, options.env ?? {}),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('host start timeout\n' + stderr.slice(-3000))), 90000);
    const poll = setInterval(() => {
      const line = stdout.split('\n').find((l) => l.startsWith('dsh web: '));
      if (line !== undefined) { clearInterval(poll); clearTimeout(timer); resolveUrl(line.slice('dsh web: '.length).trim()); }
      else if (child.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error('host exited\n' + stderr.slice(-4000))); }
    }, 150);
  });
  const auth = await fetch(url, { redirect: 'manual' });
  const cookies = auth.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  const handle = {
    pid: child.pid, port, origin: `http://127.0.0.1:${port}`, cookie,
    // The greeting URL carries the one-time token; a human must open this one
    // (the driver's own cookie is what the headless client uses).
    tokenUrl: url,
    home, workspace, outside: prepared.outside, dir, scenarioPath,
    eventsPath: join(home, 'arbiter', 'events.jsonl'),
  };
  await writeFile(join(dir, 'host.json'), JSON.stringify({ ...handle, cookie: '<redacted>' }, null, 2));
  const stop = async (signal = 'SIGTERM') => {
    try { child.kill(signal); } catch {}
    await new Promise((r) => setTimeout(r, 900));
    try { child.kill('SIGKILL'); } catch {}
    await writeFile(join(dir, 'stdout.txt'), stdout);
    await writeFile(join(dir, 'stderr.txt'), stderr);
  };
  return { handle, tokenUrl: url, stdout: () => stdout, stderr: () => stderr, stop };
}
