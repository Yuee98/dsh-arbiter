/**
 * Shared setup for this run: isolated DSH_HOME, a profile that mounts the real
 * plugin by link, and a deterministic LLM fixture.
 */
import { cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

export const RUN_ROOT = resolve(new URL('..', import.meta.url).pathname);
export const REPO = resolve(RUN_ROOT, '../../..');
export const FIXTURE = join(RUN_ROOT, 'probes', 'barrier-llm.mjs');
export const BRIDGE = join(RUN_ROOT, 'probes', 'command-bridge');
export const DSH = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
export const CLI =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';

/** Strip every inherited DSH_* before setting the isolated home. */
export function isolatedEnv(home, extra = {}) {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_')) continue;
    env[key] = value;
  }
  env.DSH_HOME = home;
  env.DSH_TELEMETRY_DISABLED = '1';
  env.ELECTRON_RUN_AS_NODE = '1';
  return { ...env, ...extra };
}

export async function makeProfile({ home, name = 'arb', scenario, workspace, patchRows = [], bundles, linkPlugin = true, sandboxMode = 'workspace-write', documentsDirectory, bridge = false }) {
  const dir = join(home, 'profiles', name);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, 'package.json'),
    JSON.stringify({
      name: `dsh-profile-${name}`,
      private: true,
      dependencies: {
        ...(linkPlugin ? { 'dsh-arbiter': `link:${REPO}` } : {}),
        ...(bridge === true ? { 'pui-command-bridge': `link:${BRIDGE}` } : {}),
      },
      dsh: {
        profile: {
          bundles: bundles ?? [
            '@deepseek-ai/dsh-base',
            '@deepseek-ai/dsh-web-app',
            'dsh-arbiter',
            ...(bridge === true ? ['pui-command-bridge'] : []),
          ],
        },
      },
    }, null, 2) + '\n',
  );
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const scope = join(dir, 'node_modules');
  await mkdir(scope, { recursive: true });
  if (linkPlugin) await symlink(REPO, join(scope, 'dsh-arbiter'), 'dir').catch(() => {});
  if (bridge === true) {
    // A symlink is not enough: the webserver resolves client bundle URLs
    // against real files under the profile, so copy the package in.
    await cp(BRIDGE, join(scope, 'pui-command-bridge'), { recursive: true }).catch(() => {});
  }
  const rows = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'pui', model: 'fixture-1' } },
    { id: 'sandbox-policy', name: '@deepseek-ai/dsh-sandbox-policy', config: { mode: sandboxMode, workspaceRoot: workspace } },
    // The approval default must match the composed preset table, otherwise the
    // preset service refuses to construct ("composed defaults match no preset").
    { id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: sandboxMode === 'danger-full-access' ? 'never' : 'ask' } },
    ...(sandboxMode === 'danger-full-access'
      ? [{ id: 'permission', name: '@deepseek-ai/dsh-permission-presets', config: { defaultPreset: 'danger-full-access' } }]
      : []),
    // Pin the first-use Workspace directory instead of letting the host probe
    // the system Documents folder through `osascript`, which trips macOS
    // Full Disk Access (kTCCServiceSystemPolicyAllFiles) on this machine.
    ...(documentsDirectory === undefined
      ? []
      : [{ id: 'workspace-controller', name: '@deepseek-ai/dsh-api-workspace-controller', config: { documentsDirectory } }]),
    { insert: [
      { id: 'pui-llm', name: 'file://' + FIXTURE, config: { provider: 'pui', scenarioPath: scenario } },
    ] },
    ...patchRows,
  ];
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(rows, null, 2) + '\n');
  return dir;
}

/** Seed the isolated workspace registry so new sessions open in the case dir. */
export async function seedWorkspace(home, workspace) {
  const dir = join(home, 'storages');
  await mkdir(dir, { recursive: true });
  const id = '01920000-0000-4000-8000-000000000001';
  await writeFile(join(dir, 'workspace.json'), JSON.stringify({
    unit: { name: 'workspace', version: 2 },
    global: { initialized: true, workspaceIds: [id], archivedSessionIds: [], pinnedSessionIds: [], defaultWorkspaceId: id },
    tables: {
      workspaces: {
        [id]: { path: workspace, title: 'recovery-workspace', sessionIds: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() },
      },
    },
  }, null, 2));
}

export async function prepareCase(caseDir) {
  const dir = resolve(caseDir);
  const home = join(dir, 'home');
  const workspace = join(dir, 'ws');
  const outside = join(dir, 'outside');
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  const scenarioPath = join(dir, 'scenario.json');
  if (existsSync(scenarioPath)) {
    const text = (await readFile(scenarioPath, 'utf8'))
      .split('{{WS}}').join(workspace)
      .split('{{OUTSIDE}}').join(outside)
      .split('{{CASE}}').join(dir);
    await writeFile(scenarioPath, text);
  }
  await seedWorkspace(home, workspace);
  return { dir, home, workspace, outside, scenarioPath };
}

/** List session logs under an isolated home. */
export async function sessionLogs(home) {
  const { readdir } = await import('node:fs/promises');
  const out = [];
  const root = join(home, 'sessions');
  if (!existsSync(root)) return out;
  for (const workspaceKey of await readdir(root)) {
    for (const sessionId of await readdir(join(root, workspaceKey)).catch(() => [])) {
      const sessionDir = join(root, workspaceKey, sessionId);
      for (const file of await readdir(sessionDir).catch(() => [])) {
        if (file.startsWith('session.') && file.includes('jsonl')) {
          out.push({ sessionId, path: join(sessionDir, file) });
        }
      }
    }
  }
  return out;
}

export { dirname };
