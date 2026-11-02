import { execFile } from 'node:child_process';
import { cp, mkdir, readFile, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  withArea,
  planOf,
  fixtureOf,
  fixtureCell,
  chatAnswer,
  cellIdOf,
} from '../evals/helpers/run.js';
import { manifest, reviewCase } from '../evals/fixtures/documents.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';

const execute = promisify(execFile);
const root = fileURLToPath(new URL('../../', import.meta.url));

describe(
  'Git report archive and legacy continuation',
  { timeout: 60_000 },
  () => {
    it('preserves tested provenance and permits continuation after report-only dirtiness and commits', async () => {
      await withArea(async (area) => {
        // Execute the real entry point in a separate clean Git checkout: the tested
        // code provenance and the report archive genuinely share this repository.
        const checkout = join(area.path, 'code');
        await mkdir(checkout);
        for (const path of [
          'src',
          'evals/src',
          'evals/schemas',
          'evals/rubrics',
          'package.json',
        ]) {
          await cp(join(root, path), join(checkout, path), { recursive: true });
        }
        await symlink(
          join(root, 'node_modules'),
          join(checkout, 'node_modules'),
          'dir',
        );
        await writeFile(join(checkout, '.gitignore'), 'node_modules/\n');
        const git = async (...args: string[]) =>
          (await execute('git', ['-C', checkout, ...args])).stdout.trim();
        const commit = async (message: string) =>
          git(
            '-c',
            'user.name=Synthetic',
            '-c',
            'user.email=fixture@example.invalid',
            'commit',
            '-qm',
            message,
          );
        await git('init', '-q');
        await git('add', '.');
        await commit('test: isolated evaluated code');
        expect(await git('status', '--porcelain')).toBe('');
        const measured = await git('rev-parse', 'HEAD');
        await area.write(
          'dataset/manifest.json',
          manifest(['case-a'], { datasetId: 'synthetic' }),
        );
        await area.write('dataset/cases/case-a.json', reviewCase());
        await area.write(
          'plan.json',
          planOf({
            datasetId: 'synthetic',
            datasetPath: join(area.path, 'dataset'),
            caseIds: ['case-a'],
            fixture: join(area.path, 'fixture.json'),
          }),
        );
        await area.write(
          'fixture.json',
          fixtureOf({
            [cellIdOf({
              caseId: 'case-a',
              targetId: 'chat-a',
              protocol: 'chat',
            })]: fixtureCell({ chat: [chatAnswer(1, 9)] }),
          }),
        );
        const directory = join(area.path, 'run');
        const cli = async (...args: string[]) =>
          execute(
            process.execPath,
            [join(checkout, 'evals/src/cli.ts'), ...args],
            { cwd: checkout },
          );
        const args = ['run', join(area.path, 'plan.json'), '--dir', directory];
        await cli(...args);
        const initial = await readRun(directory, await compileRunCheckers());
        if (!initial.ok) throw new Error('missing initial run');
        expect(initial.artifact.index.provenance?.codeGit).toMatchObject({
          revision: measured,
          dirty: false,
        });
        const state = initial.artifact.index.cells[0];
        if (state === undefined) throw new Error('missing record');
        const recordBefore = await readFile(
          join(directory, state.record),
          'utf8',
        );
        const prefix = join(
          checkout,
          'validation/review-quality/archive/report',
        );
        await cli('report', directory, '--out', prefix);
        expect(await git('status', '--porcelain')).toContain('validation/');
        await cli(...args, '--resume');
        await git('add', 'validation');
        await commit('docs: archive synthetic report');
        expect(await git('rev-parse', 'HEAD')).not.toBe(measured);
        expect(await git('status', '--porcelain')).toBe('');
        await cli(...args, '--resume');
        const resumed = await readRun(directory, await compileRunCheckers());
        if (!resumed.ok) throw new Error('missing continued run');
        expect(resumed.artifact.index.provenance).toEqual(
          initial.artifact.index.provenance,
        );
        expect(await readFile(join(directory, state.record), 'utf8')).toBe(
          recordBefore,
        );
        const report: unknown = JSON.parse(
          await readFile(`${prefix}.json`, 'utf8'),
        );
        expect(report).toHaveProperty(
          'publication.testedCode',
          initial.artifact.index.provenance?.codeGit,
        );
      });
    });
  },
);
