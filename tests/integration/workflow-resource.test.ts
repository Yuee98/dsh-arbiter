import { spawn, execFile } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { observeGit } from '../../evals/src/run/provenance.js';
import { RUN_FILES } from '../../evals/src/run/artifact.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';

const execute = promisify(execFile);
const register = fileURLToPath(
  new URL('../../evals/src/cli/register.ts', import.meta.url),
);
const resourceModule = new URL(
  '../../evals/src/run/resource.ts',
  import.meta.url,
).href;

describe('workflow resource storage across processes', () => {
  it('shares the same claim across processes and admits only after the other holder exits cleanly', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      const home = await mkdtemp(join(area.directory, 'dsh-home-'));
      const script = `import { readFile } from 'node:fs/promises';
        const { withResourceClaim } = await import(${JSON.stringify(resourceModule)});
        const plan = JSON.parse(await readFile(process.argv[1], 'utf8'));
        await withResourceClaim(plan, plan.resource.runDirectory, async () => {
          process.stdout.write('held\\n');
          await new Promise(done => process.stdin.once('data', done));
        });`;
      const child = spawn(
        process.execPath,
        [
          '--import',
          register,
          '--input-type=module',
          '-e',
          script,
          area.planPath,
        ],
        { env: { ...process.env, DSH_HOME: home }, stdio: 'pipe' },
      );
      const exited = once(child, 'exit');
      try {
        const readyEvent: unknown = await once(child.stdout, 'data', {
          signal: AbortSignal.timeout(10000),
        });
        if (!Array.isArray(readyEvent))
          throw new Error('invalid readiness event');
        const ready: unknown = readyEvent[0];
        expect(String(ready)).toContain('held');
        expect(await area.cli(['run', area.planPath])).toBe(1);
        expect(area.log.join('\n')).toContain(
          'another process holds the run claim',
        );
        child.stdin.end('finish');
        expect((await exited)[0]).toBe(0);
        expect(await area.cli(['run', area.planPath])).toBe(0);
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    });
  }, 20000);

  it('preserves a crashed process claim rather than treating unknown dispatch as a fresh allowance', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      const home = await mkdtemp(join(area.directory, 'dsh-home-'));
      const script = `import { readFile } from 'node:fs/promises';
        const { withResourceClaim } = await import(${JSON.stringify(resourceModule)});
        const plan = JSON.parse(await readFile(process.argv[1], 'utf8'));
        await withResourceClaim(plan, plan.resource.runDirectory, async lease => {
          lease.started = true;
          process.stdout.write('held\\n');
          await new Promise(done => process.stdin.once('data', done));
        });`;
      const child = spawn(
        process.execPath,
        [
          '--import',
          register,
          '--input-type=module',
          '-e',
          script,
          area.planPath,
        ],
        { env: { ...process.env, DSH_HOME: home }, stdio: 'pipe' },
      );
      const exited = once(child, 'exit');
      try {
        const readyEvent: unknown = await once(child.stdout, 'data', {
          signal: AbortSignal.timeout(10000),
        });
        if (!Array.isArray(readyEvent))
          throw new Error('invalid readiness event');
        const ready: unknown = readyEvent[0];
        expect(String(ready)).toContain('held');
        child.kill('SIGKILL');
        await exited;
        expect(
          await readFile(join(area.runDirectory, RUN_FILES.lock), 'utf8'),
        ).toContain(String(child.pid));
        expect(await area.cli(['run', area.planPath])).toBe(1);
        expect(area.log.join('\n')).toContain(
          'another process holds the run claim',
        );
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          child.kill('SIGKILL');
          await exited;
        }
      }
    });
  }, 20000);

  it('records a real committed revision, dirty state, and unavailable Git as distinct observations', async () => {
    await withWorkflowArea(async (area) => {
      const before = await observeGit(area.directory);
      expect(before.revision).toBeNull();
      expect(before.dirty).toBeNull();
      expect(before.reason).toContain('unavailable');
      const git = async (args: readonly string[]): Promise<string> =>
        (await execute('git', ['-C', area.directory, ...args])).stdout.trim();
      await git(['init', '-q', '-b', 'main']);
      await writeFile(join(area.directory, 'tracked.txt'), 'original');
      await writeFile(
        join(area.directory, '.gitignore'),
        'plan.json\nfixture.json\nrun/\n',
      );
      await git(['add', 'tracked.txt', '.gitignore', 'dataset']);
      await git([
        '-c',
        'user.name=Workflow Fixture',
        '-c',
        'user.email=fixture@example.invalid',
        'commit',
        '-q',
        '-m',
        'test: create isolated provenance fixture',
      ]);
      const revision = await git(['rev-parse', 'HEAD']);
      const committed = await observeGit(area.directory);
      expect(committed.revision).toBe(revision);
      // All current source files are committed in this isolated fixture.
      expect(committed.dirty).toBe(false);
      await writeFile(join(area.directory, 'tracked.txt'), 'edited');
      const dirty = await observeGit(area.directory);
      expect(dirty.revision).toBe(revision);
      expect(dirty.dirty).toBe(true);
      expect(dirty.reason).toBeNull();
      await writeFile(join(area.datasetPath, 'untracked.json'), '{}');
      const untracked = await observeGit(area.datasetPath, ['untracked.json']);
      expect(untracked.revision).toBeNull();
      expect(untracked.reason).toContain('outside the tracked revision');
    });
  });
});
