import { constants } from 'node:fs';
import {
  access,
  mkdir,
  mkdtemp,
  realpath,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, resolve } from 'node:path';

export const profileName = 'arbiter-e2e';

export interface IsolatedProfile {
  readonly root: string;
  readonly home: string;
  readonly workspace: string;
}

/** Never inherit the user's selected profile, credentials or model settings. */
export function isolatedEnv(home: string): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (key.startsWith('DSH_') || /(?:API_KEY|ACCESS_TOKEN)$/.test(key))
      continue;
    env[key] = value;
  }
  env['DSH_HOME'] = home;
  env['DSH_TELEMETRY_DISABLED'] = '1';
  return env;
}

/** An explicit executable override or the installed public CLI on PATH. */
export async function resolveDshBinary(): Promise<string> {
  const override = process.env['DSH_E2E_BIN']?.trim() || undefined;
  if (override !== undefined && !isAbsolute(override)) {
    throw new Error('DSH_E2E_BIN must be an absolute executable path.');
  }
  const executable =
    override ?? (process.platform === 'win32' ? 'dsh.cmd' : 'dsh');
  const candidates = isAbsolute(executable)
    ? [executable]
    : (process.env['PATH'] ?? '')
        .split(delimiter)
        .map((entry) => resolve(entry, executable));
  for (const candidate of candidates) {
    try {
      await access(candidate, constants.X_OK);
      if (!(await stat(candidate)).isFile()) continue;
      // Preserve the launcher path: the installed CLI resolves its own assets.
      return candidate;
    } catch {
      // Continue through PATH, then fail clearly rather than skipping the suite.
    }
  }
  throw new Error(
    'DSH is required for E2E. Install its public CLI or set DSH_E2E_BIN to its absolute executable path.',
  );
}

/** The same public link: profile format as `dsh plugin add`, without downloads. */
export async function createIsolatedProfile(
  repoRoot: string,
): Promise<IsolatedProfile> {
  const root = await mkdtemp(join(tmpdir(), 'arbiter-e2e-'));
  const home = join(root, 'home');
  const workspace = join(root, 'workspace');
  const profile = join(home, 'profiles', profileName);
  await mkdir(join(profile, 'node_modules'), { recursive: true });
  await mkdir(workspace, { recursive: true });
  await writeFile(
    join(profile, 'package.json'),
    JSON.stringify(
      {
        name: 'arbiter-e2e-profile',
        private: true,
        dependencies: { 'dsh-arbiter': `link:${await realpath(repoRoot)}` },
        dsh: {
          profile: {
            bundles: [
              '@deepseek-ai/dsh-base',
              '@deepseek-ai/dsh-web-app',
              'dsh-arbiter',
            ],
          },
        },
      },
      null,
      2,
    ),
  );
  await symlink(
    repoRoot,
    join(profile, 'node_modules', 'dsh-arbiter'),
    'junction',
  );
  await writeFile(join(profile, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(profile, 'cordis.yml'), '[]\n');
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      // The prototype parser expects an object even when using all defaults.
      { id: 'arbiter', name: 'dsh-arbiter', config: {} },
      {
        id: 'sandbox-policy',
        name: '@deepseek-ai/dsh-sandbox-policy',
        config: { mode: 'workspace-write', workspaceRoot: workspace },
      },
      {
        id: 'workspace-controller',
        name: '@deepseek-ai/dsh-api-workspace-controller',
        config: { documentsDirectory: workspace },
      },
    ]),
  );
  return { root, home, workspace };
}
