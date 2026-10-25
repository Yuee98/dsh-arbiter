import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createIsolatedProfile,
  isolatedEnv,
  profileName,
  resolveDshCommand,
} from '../e2e/dsh/profile.js';

const execFileAsync = promisify(execFile);
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-dsh-fixture-'));
  vi.stubEnv('DSH_E2E_CLI', '');
  vi.stubEnv('DSH_E2E_BIN', '');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

describe('isolated DSH launch contract', () => {
  it('runs an npm JavaScript CLI with spaces in its path without a shell', async () => {
    const cli = join(root, 'public cli.mjs');
    await writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)));');
    vi.stubEnv('DSH_E2E_CLI', cli);
    const command = await resolveDshCommand();
    const result = await execFileAsync(command.executable, [
      ...command.args,
      '--profile',
      'a profile; echo unexpected',
    ]);
    expect(command.executable).toBe(process.execPath);
    expect(JSON.parse(result.stdout)).toEqual([
      '--profile',
      'a profile; echo unexpected',
    ]);
  });

  it('preserves an explicitly selected installed launcher', async () => {
    vi.stubEnv('DSH_E2E_BIN', process.execPath);
    expect(await resolveDshCommand()).toEqual({
      executable: process.execPath,
      args: [],
    });
  });

  it.each(['DSH_E2E_CLI', 'DSH_E2E_BIN'])(
    'rejects a relative %s override',
    async (key) => {
      vi.stubEnv(key, 'relative/cli');
      await expect(resolveDshCommand()).rejects.toThrow('absolute');
    },
  );

  it('rejects conflicting carriers and missing entry files', async () => {
    vi.stubEnv('DSH_E2E_CLI', join(root, 'missing.mjs'));
    vi.stubEnv('DSH_E2E_BIN', process.execPath);
    await expect(resolveDshCommand()).rejects.toThrow('only one');
    vi.stubEnv('DSH_E2E_BIN', '');
    await expect(resolveDshCommand()).rejects.toThrow('ENOENT');
    vi.stubEnv('DSH_E2E_CLI', root);
    await expect(resolveDshCommand()).rejects.toThrow('not a file');
  });

  it('replaces inherited DSH configuration and strips model credentials', () => {
    vi.stubEnv('DSH_HOME', '/daily/profile');
    vi.stubEnv('DSH_PROFILE', 'daily');
    vi.stubEnv('REVIEWER_API_KEY', 'test-only-key');
    vi.stubEnv('REVIEWER_ACCESS_TOKEN', 'test-only-token');
    const env = isolatedEnv(root);
    expect(env['DSH_HOME']).toBe(root);
    expect(env['DSH_PROFILE']).toBeUndefined();
    expect(env['DSH_TELEMETRY_DISABLED']).toBe('1');
    expect(env['REVIEWER_API_KEY']).toBeUndefined();
    expect(env['REVIEWER_ACCESS_TOKEN']).toBeUndefined();
  });

  it('creates independent homes linked only to the current checkout', async () => {
    const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
    const profiles = await Promise.all([
      createIsolatedProfile(repoRoot),
      createIsolatedProfile(repoRoot),
    ]);
    try {
      expect(profiles[0].home).not.toBe(profiles[1].home);
      for (const profile of profiles) {
        const directory = join(profile.home, 'profiles', profileName);
        expect(
          await realpath(join(directory, 'node_modules', 'dsh-arbiter')),
        ).toBe(await realpath(repoRoot));
        expect(
          await readFile(join(directory, 'cordis.patch.yml'), 'utf8'),
        ).toContain(profile.workspace.replaceAll('\\', '\\\\'));
      }
    } finally {
      await Promise.all(
        profiles.map((profile) =>
          rm(profile.root, { recursive: true, force: true }),
        ),
      );
    }
  });
});
