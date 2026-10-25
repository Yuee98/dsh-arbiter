/**
 * Start one isolated Web host, authenticate, and return a small JSON handle.
 * Usage: node scripts/host.mjs <caseDir> <port>
 * Writes stdout/stderr/url/cookies into <caseDir>.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { makeProfile, dshBin, dshCli } from './profile.mjs';

const caseDir = process.argv[2];
const port = process.argv[3];
if (!caseDir || !port) { console.error('usage: host.mjs <caseDir> <port>'); process.exit(2); }

const home = join(caseDir, 'home');
const profile = 'pui';
const scenarioPath = join(caseDir, "scenario.json");
const workspace = join(caseDir, 'ws');
const outside = join(caseDir, 'outside');
const statePath = join(home, 'pui', 'events.jsonl');

await mkdir(home, { recursive: true });
await mkdir(workspace, { recursive: true });
await mkdir(outside, { recursive: true });
// The scenario is authored by the caller; the profile points at it.
const sandboxMode = process.env.PUI_SANDBOX ?? 'workspace-write';
// Substitute the per-case placeholders in the authored scenario.
const scenarioText = (await readFile(scenarioPath, 'utf8'))
  .split('{{WS}}').join(workspace)
  .split('{{OUTSIDE}}').join(outside);
await writeFile(scenarioPath, scenarioText);

await makeProfile({
  home, profile, llmScenario: scenarioPath, workspace,
  patchRows: [
    { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: sandboxMode, workspaceRoot: workspace } },
  ],
});

/** Strip every inherited DSH_* (the parent session exports desktop values). */
function isolatedEnv(home) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  env.DSH_HOME = home;
  env.DSH_TELEMETRY_DISABLED = '1';
  env.ELECTRON_RUN_AS_NODE = '1';
  return env;
}

const out = join(caseDir, 'stdout.txt');
const err = join(caseDir, 'stderr.txt');
const child = spawn(dshBin(), ['--expose-internals', dshCli(), '--profile', profile, '--no-open', '--port', port], {
  cwd: workspace,
  env: isolatedEnv(home),
  stdio: ['ignore', 'pipe', 'pipe'],
});
let stdout = '', stderr = '';
child.stdout.setEncoding('utf8');
child.stderr.setEncoding('utf8');
child.stdout.on('data', (c) => { stdout += c; });
child.stderr.on('data', (c) => { stderr += c; });
await writeFile(join(caseDir, 'pid.txt'), String(child.pid));

async function waitForUrl(ms = 40000) {
  const started = Date.now();
  while (Date.now() - started < ms) {
    const line = stdout.split('\n').find((l) => l.startsWith('dsh web: '));
    if (line) return line.slice('dsh web: '.length).trim();
    if (child.exitCode !== null) break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return undefined;
}

const url = await waitForUrl();
if (url === undefined) {
  await writeFile(out, stdout); await writeFile(err, stderr);
  console.log(JSON.stringify({ ok: false, stdout: stdout.slice(-2000), stderr: stderr.slice(-4000) }));
  process.exit(1);
}

const cookies = join(caseDir, 'cookies.txt');
const auth = await fetch(url, { redirect: 'manual' });
const setCookie = auth.headers.getSetCookie?.() ?? [];
await writeFile(cookies, setCookie.join('\n'));
const cookie = setCookie.map((c) => c.split(';')[0]).join('; ');

await writeFile(out, '');
await writeFile(err, '');
await writeFile(join(caseDir, 'url.txt'), url.replace(/token=[^&]+/u, 'token=<redacted>') + '\n');

console.log(JSON.stringify({
  ok: true,
  pid: child.pid,
  port,
  origin: `http://127.0.0.1:${port}`,
  authStatus: auth.status,
  cookiePresent: cookie.length > 0,
  cookie,
  statePath,
  home,
  workspace,
  outside,
  stdoutLog: out,
  stderrLog: err,
}));

// Keep the process alive while the parent driver runs; the driver kills us via pid.
process.on('SIGTERM', () => { child.kill('SIGTERM'); process.exit(0); });
setInterval(() => {}, 1 << 30);
