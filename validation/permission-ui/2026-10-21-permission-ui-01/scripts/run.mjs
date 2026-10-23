/**
 * One case = one isolated DSH_HOME + profile + Web host + real browser driver.
 * The host is a child of this process, so its lifetime is bounded by the run.
 */
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { makeProfile, dshBin, dshCli } from './profile.mjs';

export async function boot(caseDirArg, port) {
  // Every path handed to the child must be absolute: the child's cwd differs.
  const caseDir = resolve(caseDirArg);
  const home = join(caseDir, 'home');
  const workspace = join(caseDir, 'ws');
  const outside = join(caseDir, 'outside');
  const scenarioPath = join(caseDir, 'scenario.json');
  const scenarioText = (await readFile(scenarioPath, 'utf8'))
    .split('{{WS}}').join(workspace)
    .split('{{OUTSIDE}}').join(outside)
    .split('{{CASE}}').join(caseDir);
  await writeFile(scenarioPath, scenarioText);
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await makeProfile({
    home, profile: 'pui', llmScenario: scenarioPath, workspace,
    patchRows: [
      { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: process.env.PUI_SANDBOX ?? 'workspace-write', workspaceRoot: workspace } },
    ],
  });
  await seedWorkspace(home, workspace);
  const env = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('DSH_')) env[k] = v;
  env.DSH_HOME = home; env.DSH_TELEMETRY_DISABLED = '1'; env.ELECTRON_RUN_AS_NODE = '1';
  const child = spawn(dshBin(), ['--expose-internals', dshCli(), '--profile', 'pui', '--no-open', '--port', String(port)], {
    cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '', stderr = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', (c) => { stdout += c; });
  child.stderr.on('data', (c) => { stderr += c; });
  const url = await new Promise((resolveUrl, reject) => {
    const timer = setTimeout(() => reject(new Error('host start timeout\n' + stdout.slice(-1500) + stderr.slice(-2000))), 60000);
    const poll = setInterval(() => {
      const line = stdout.split('\n').find((l) => l.startsWith('dsh web: '));
      if (line !== undefined) { clearInterval(poll); clearTimeout(timer); resolveUrl(line.slice('dsh web: '.length).trim()); }
      else if (child.exitCode !== null) { clearInterval(poll); clearTimeout(timer); reject(new Error('host exited\n' + stdout.slice(-1000) + stderr.slice(-3000))); }
    }, 150);
  });
  const auth = await fetch(url, { redirect: 'manual' });
  const cookies = auth.headers.getSetCookie?.() ?? [];
  const cookie = cookies.map((c) => c.split(';')[0]).join('; ');
  const handle = {
    pid: child.pid, port, origin: `http://127.0.0.1:${port}`, cookie,
    authStatus: auth.status, home, workspace, outside, scenarioPath,
    eventsPath: join(home, 'pui', 'events.jsonl'),
  };
  await writeFile(join(caseDir, 'host.json'), JSON.stringify(handle, null, 2));
  const stop = async () => {
    try { child.kill('SIGTERM'); } catch {}
    await new Promise((r) => setTimeout(r, 800));
    try { child.kill('SIGKILL'); } catch {}
    await writeFile(join(caseDir, 'stdout.txt'), stdout);
    await writeFile(join(caseDir, 'stderr.txt'), stderr);
  };
  return { handle, stdout: () => stdout, stderr: () => stderr, stop };
}

export async function logEvents(handle) {
  try {
    return (await readFile(handle.eventsPath, 'utf8')).split('\n').filter((l) => l.trim() !== '').map((l) => JSON.parse(l));
  } catch { return []; }
}

export async function marker(path) {
  try { return { exists: true, content: (await readFile(path, 'utf8')).slice(0, 200) }; }
  catch { return { exists: false }; }
}

/**
 * Seed the isolated workspace registry so the GUI's new session opens inside
 * the case workspace instead of the user's default documents folder.
 */
export async function seedWorkspace(home, workspace) {
  const { writeFile, mkdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const dir = join(home, 'storages');
  await mkdir(dir, { recursive: true });
  const id = '01920000-0000-4000-8000-000000000001';
  const state = {
    unit: { name: 'workspace', version: 2 },
    global: {
      initialized: true,
      workspaceIds: [id],
      archivedSessionIds: [],
      pinnedSessionIds: [],
      defaultWorkspaceId: id,
    },
    tables: {
      workspaces: {
        [id]: {
          path: workspace,
          title: 'pui-validation-workspace',
          sessionIds: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      },
    },
  };
  await writeFile(join(dir, 'workspace.json'), JSON.stringify(state, null, 2));
  return id;
}
