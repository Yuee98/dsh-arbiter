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
  /** The profile patch the plugin and the settings UI share. */
  readonly documentPath: string;
}

/** One hand-declared provider route seeded for the catalog cases. */
export interface SeededModelGroup {
  readonly provider: string;
  readonly displayName: string;
  readonly models: readonly { readonly id: string; readonly name: string }[];
  /**
   * Endpoint for this route. Defaults to a closed local port, so a probe fails
   * fast; a test that needs an in-flight window passes a controllable server.
   */
  readonly baseURL?: string;
  /**
   * Static request headers for the route.
   *
   * The OpenAI-compatible protocol refuses to dispatch with no credential and
   * no authorization header. This is a configuration value for a local test
   * server, not a stored credential: nothing is written to a credential store.
   */
  readonly headers?: Readonly<Record<string, string>>;
}

export interface ProfileOptions {
  /**
   * `empty` writes an explicit empty object, while `unset` omits the user
   * config entirely so the plugin must apply the first-install defaults.
   */
  readonly arbiterConfig?: 'empty' | 'unset';
  /**
   * Hand-declared `llm-pi-ai` routes, so the real host model directory is not
   * empty without a credential or any network call: pi-ai resolves these
   * models from configuration alone.
   */
  readonly modelGroups?: readonly SeededModelGroup[];
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

export interface DshCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

/** Use the npm CLI directly on every OS, or preserve an installed launcher. */
export async function resolveDshCommand(): Promise<DshCommand> {
  const cli = process.env['DSH_E2E_CLI']?.trim() || undefined;
  if (cli !== undefined) {
    if (!isAbsolute(cli)) {
      throw new Error('DSH_E2E_CLI must be an absolute JavaScript entry path.');
    }
    if (process.env['DSH_E2E_BIN']?.trim()) {
      throw new Error('Set only one of DSH_E2E_CLI and DSH_E2E_BIN.');
    }
    await access(cli, constants.R_OK);
    if (!(await stat(cli)).isFile())
      throw new Error('DSH_E2E_CLI is not a file.');
    return { executable: process.execPath, args: [cli] };
  }
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
      return { executable: candidate, args: [] };
    } catch {
      // Continue through PATH, then fail clearly rather than skipping the suite.
    }
  }
  throw new Error(
    'DSH is required for E2E. Install its public CLI or set DSH_E2E_BIN to its absolute executable path.',
  );
}

/**
 * A `llm-pi-ai` row that declares the given routes itself.
 *
 * No `apiKeyEnv` is named, so the adapter reads no credential; models resolve
 * from the declared catalog. The default base URL is a closed local port, which
 * only matters if a test streams a request — the catalog listing never connects.
 * A group may name its own endpoint when a test needs a reachable one.
 */
function seededModelRow(
  groups: readonly SeededModelGroup[] | undefined,
): readonly unknown[] {
  if (groups === undefined || groups.length === 0) return [];
  const providers = Object.fromEntries(
    groups.map((group) => [
      group.provider,
      {
        displayName: group.displayName,
        api: 'openai-completions',
        baseURL: group.baseURL ?? 'http://127.0.0.1:9/v1',
        ...(group.headers === undefined ? {} : { headers: group.headers }),
        models: group.models.map((model) => ({
          id: model.id,
          name: model.name,
          contextWindow: 32768,
          maxTokens: 4096,
        })),
      },
    ]),
  );
  return [
    {
      id: 'llm-pi-ai',
      name: '@deepseek-ai/dsh-llm-pi-ai',
      config: { providers },
    },
  ];
}

/** The same public link: profile format as `dsh plugin add`, without downloads. */
export async function createIsolatedProfile(
  repoRoot: string,
  options: ProfileOptions = {},
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
  const arbiterRow =
    options.arbiterConfig === 'unset'
      ? { id: 'arbiter', name: 'dsh-arbiter' }
      : { id: 'arbiter', name: 'dsh-arbiter', config: {} };
  await writeFile(
    join(profile, 'cordis.patch.yml'),
    JSON.stringify([
      arbiterRow,
      ...seededModelRow(options.modelGroups),
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
  return {
    root,
    home,
    workspace,
    documentPath: join(profile, 'cordis.patch.yml'),
  };
}
