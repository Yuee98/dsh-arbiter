import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  createIsolatedProfile,
  isolatedEnv,
  profileName,
  resolveDshCommand,
} from './profile.js';
import { launchHost, redactHostLog, stopHost } from './process.js';

const execFileAsync = promisify(execFile);

export interface DshHost {
  readonly origin: string;
  readonly cookie: { readonly name: string; readonly value: string };
  readonly home: string;
  readonly workspace: string;
  readonly stop: () => Promise<void>;
}

async function buildFingerprint(
  repoRoot: string,
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  const runtimeFiles = (
    await readdir(join(repoRoot, 'lib'), { recursive: true })
  )
    .filter((file) => /\.(?:js|cjs)$/.test(file))
    .map((file) => `lib/${file}`);
  const localeFiles = (
    await readdir(join(repoRoot, 'locale'), { recursive: true })
  )
    .filter((file) => file.endsWith('.json'))
    .map((file) => `locale/${file}`);
  for (const file of [
    ...runtimeFiles,
    ...localeFiles,
    'package.json',
    'cordis.patch.yml',
  ].sort()) {
    try {
      result[file] = createHash('sha256')
        .update(await readFile(join(repoRoot, file)))
        .digest('hex');
    } catch (cause) {
      throw new Error(
        'Build the current checkout with pnpm build before DSH E2E.',
        { cause },
      );
    }
  }
  return result;
}

async function authenticate(url: string): Promise<DshHost['cookie']> {
  const response = await fetch(url, {
    redirect: 'manual',
    signal: AbortSignal.timeout(10_000),
  });
  const rawCookie = response.headers.getSetCookie()[0]?.split(';')[0];
  const separator = rawCookie?.indexOf('=') ?? -1;
  if (rawCookie === undefined || separator < 1) {
    throw new Error(
      `DSH did not issue a bootstrap session cookie (HTTP ${String(response.status)}).`,
    );
  }
  return {
    name: rawCookie.slice(0, separator),
    value: rawCookie.slice(separator + 1),
  };
}

/** Fresh home/profile, OS-assigned port, current built plugin; no model requests. */
export async function startDshHost(
  repoRoot: string,
  artifacts: string,
): Promise<DshHost> {
  await mkdir(artifacts, { recursive: true });
  const fingerprint = await buildFingerprint(repoRoot);
  const command = await resolveDshCommand();
  const profile = await createIsolatedProfile(repoRoot);
  const env = isolatedEnv(profile.home);
  let host: ReturnType<typeof launchHost> | undefined;
  const stop = async (): Promise<void> => {
    try {
      if (host !== undefined) await stopHost(host.child);
    } finally {
      if (host !== undefined) {
        await writeFile(
          join(artifacts, 'host.stdout.log'),
          redactHostLog(host.stdout()),
        );
        await writeFile(
          join(artifacts, 'host.stderr.log'),
          redactHostLog(host.stderr()),
        );
      }
      await rm(profile.root, { recursive: true, force: true });
    }
  };
  try {
    const version = await execFileAsync(
      command.executable,
      [...command.args, '--version'],
      {
        env,
        timeout: 10_000,
      },
    );
    const expectedVersion = process.env['DSH_E2E_VERSION'];
    if (
      expectedVersion !== undefined &&
      version.stdout.trim() !== expectedVersion
    ) {
      throw new Error(
        `Expected DSH ${expectedVersion}, received ${version.stdout.trim()}.`,
      );
    }
    await writeFile(
      join(artifacts, 'environment.json'),
      JSON.stringify(
        {
          executable: command.executable,
          resolvedExecutable: await realpath(command.executable),
          args: command.args,
          dshVersion: version.stdout.trim(),
          nodeVersion: process.version,
          platform: process.platform,
          architecture: process.arch,
          profile: profileName,
          isolatedHome: profile.home,
          plugin: await realpath(repoRoot),
          fingerprint,
          modelRequests: 'none: UI smoke only',
        },
        null,
        2,
      ),
    );
    host = launchHost(command, profileName, profile.workspace, env);
    const tokenUrl = await host.ready;
    const origin = new URL(tokenUrl).origin;
    const cookie = await authenticate(tokenUrl);
    return {
      origin,
      cookie,
      home: profile.home,
      workspace: profile.workspace,
      stop,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}
