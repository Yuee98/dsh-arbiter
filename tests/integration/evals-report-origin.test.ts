import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, readdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { runCli } from '../../evals/src/cli/run.js';
import { claimRun, readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';

const execute = promisify(execFile);
const codeRoot = fileURLToPath(new URL('../../', import.meta.url));

describe(
  'legacy run provenance and later archive checkout',
  { timeout: 30_000 },
  () => {
    it('retains initial tested Git across rebuild/resume and keeps historical absence unknown', async () => {
      await withArea(async (area) => {
        const rubric: unknown = JSON.parse(
          await readFile(
            join(codeRoot, 'evals/rubrics/rubric-v1.json'),
            'utf8',
          ),
        );
        await area.write('evals/rubrics/rubric-v1.json', rubric);
        await area.write(
          'dataset/manifest.json',
          manifest(['case-a'], { datasetId: 'synthetic' }),
        );
        await area.write('dataset/cases/case-a.json', reviewCase());
        const plan = planOf({
          datasetId: 'synthetic',
          datasetPath: join(area.path, 'dataset'),
          caseIds: ['case-a'],
        });
        await area.write('plan.json', plan);
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
        const args = ['run', join(area.path, 'plan.json'), '--dir', directory];
        const errors: string[] = [];
        const io = {
          root: area.path,
          out: () => {},
          err: (line: string) => errors.push(line),
          env: () => {
            throw new Error('offline');
          },
        };
        const exit = await runCli(args, io);
        expect({ exit, errors: exit === 0 ? [] : errors }).toEqual({
          exit: 0,
          errors: [],
        });
        const read = await readRun(directory, await compileRunCheckers());
        if (!read.ok) throw new Error('missing run');
        const measured = (
          await execute('git', ['-C', codeRoot, 'rev-parse', 'HEAD'])
        ).stdout.trim();
        expect(read.artifact.index.provenance?.codeGit.revision).toBe(measured);
        const provenance = read.artifact.index.provenance;
        await execute('git', ['-C', area.path, 'init', '-q']);
        await execute('git', [
          '-C',
          area.path,
          '-c',
          'user.name=Synthetic',
          '-c',
          'user.email=fixture@example.invalid',
          'commit',
          '--allow-empty',
          '-qm',
          'docs: synthetic archive context',
        ]);
        const archive = (
          await execute('git', ['-C', area.path, 'rev-parse', 'HEAD'])
        ).stdout.trim();
        expect(archive).not.toBe(measured);
        const output = join(area.path, 'archive/report');
        expect(await runCli(['report', directory, '--out', output], io)).toBe(
          0,
        );
        const report: unknown = JSON.parse(
          await readFile(`${output}.json`, 'utf8'),
        );
        expect(report).toHaveProperty(
          'publication.testedCode',
          provenance?.codeGit,
        );
        expect(report).toHaveProperty(
          'publication.archiveCommit',
          'tracked-by-git-history',
        );
        const recordsBefore = await readFile(
          join(directory, read.artifact.index.cells[0]?.record ?? ''),
          'utf8',
        );
        expect(
          await runCli([...args, '--resume', '--report', '--force'], io),
        ).toBe(0);
        const resumed = await readRun(directory, await compileRunCheckers());
        if (!resumed.ok) throw new Error('missing resumed run');
        expect(resumed.artifact.index.provenance).toEqual(provenance);
        expect(
          await readFile(
            join(directory, read.artifact.index.cells[0]?.record ?? ''),
            'utf8',
          ),
        ).toBe(recordsBefore);
        const release = await claimRun(directory);
        try {
          const before = await readFile(join(directory, 'index.json'), 'utf8');
          expect(
            await runCli(
              [
                ...args,
                '--resume',
                '--report',
                '--out',
                join(area.path, 'refused'),
                '--force',
              ],
              io,
            ),
          ).toBe(1);
          await expect(
            readFile(join(area.path, 'refused.json')),
          ).rejects.toMatchObject({ code: 'ENOENT' });
          expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(
            before,
          );
        } finally {
          await release();
        }
        if (provenance === undefined)
          throw new Error('missing initial provenance');
        const { provenance: omitted, ...historical } = resumed.artifact.index;
        expect(omitted).toEqual(provenance);
        await writeFile(
          join(directory, 'index.json'),
          JSON.stringify(historical),
        );
        expect(
          await runCli(
            ['report', directory, '--out', join(area.path, 'historical')],
            io,
          ),
        ).toBe(0);
        const oldReport: unknown = JSON.parse(
          await readFile(join(area.path, 'historical.json'), 'utf8'),
        );
        expect(oldReport).toHaveProperty(
          'publication.testedCode.revision',
          null,
        );
        expect(oldReport).toHaveProperty('publication.testedCode.dirty', null);
        expect(oldReport).toHaveProperty(
          'publication.context.targetInputTokens',
          null,
        );
        const saved = historical.cells[0];
        if (saved === undefined) throw new Error('missing actual record state');
        const relativeRecord = 'summary.json';
        await rename(
          join(directory, saved.record),
          join(directory, relativeRecord),
        );
        await writeFile(
          join(directory, 'index.json'),
          JSON.stringify({
            ...historical,
            cells: historical.cells.map((cell) =>
              cell.cellId === saved.cellId
                ? { ...cell, record: relativeRecord }
                : cell,
            ),
          }),
        );
        const relocated = await readRun(directory, await compileRunCheckers());
        if (!relocated.ok)
          throw new Error('noncanonical legacy record was rejected');
        expect(relocated.artifact.records).toHaveLength(1);
        const relocatedPrefix = join(area.path, 'relocated');
        expect(
          await runCli(['report', directory, '--out', relocatedPrefix], io),
        ).toBe(0);
        const relocatedReport: unknown = JSON.parse(
          await readFile(`${relocatedPrefix}.json`, 'utf8'),
        );
        expect(relocatedReport).toHaveProperty(
          'publication.consistency.cells.0.recordPath',
          join(directory, relativeRecord),
        );
        const relocatedMarkdown = await readFile(
          `${relocatedPrefix}.md`,
          'utf8',
        );
        expect(relocatedMarkdown).toContain('[dev/legacy-v1]');
        const detailFiles = await readdir(`${relocatedPrefix}.details`);
        const detail = await readFile(
          join(`${relocatedPrefix}.details`, detailFiles[0] ?? ''),
          'utf8',
        );
        expect(detail).toContain(join(directory, relativeRecord));
        const indexBeforeRefusal = await readFile(
          join(directory, 'index.json'),
          'utf8',
        );
        expect(
          await runCli(
            [
              'report',
              directory,
              '--out',
              join(directory, 'summary'),
              '--force',
            ],
            io,
          ),
        ).toBe(1);
        for (const extension of ['md', 'html']) {
          await expect(
            readFile(join(directory, `summary.${extension}`)),
          ).rejects.toMatchObject({ code: 'ENOENT' });
        }
        await expect(
          readdir(join(directory, 'summary.details')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(join(directory, 'index.json'), 'utf8')).toBe(
          indexBeforeRefusal,
        );

        expect(await readFile(join(directory, relativeRecord), 'utf8')).toBe(
          recordsBefore,
        );
      });
    });
  },
);
