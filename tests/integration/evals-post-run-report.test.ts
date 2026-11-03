import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import { chatTarget } from '../evals/helpers/run.js';
import { inventory } from '../evals/helpers/replay.js';
import { claimRun } from '../../evals/src/run/artifact.js';

describe('explicit post-run complete publication', { timeout: 30_000 }, () => {
  it.each(['complete', 'budget', 'unsupported'] as const)(
    'publishes every planned cell after %s and preserves the run exit',
    async (kind) => {
      await withWorkflowArea(async (area) => {
        const plan =
          kind === 'budget'
            ? {
                ...area.plan,
                bounds: { ...area.plan.bounds, maxInputTokens: 5 },
              }
            : kind === 'unsupported'
              ? { ...area.plan, targets: [chatTarget()] }
              : area.plan;
        await area.write(plan);
        const output = join(area.directory, 'archive', 'report');
        expect(
          await area.cli(['run', area.planPath, '--report', '--out', output]),
        ).toBe(kind === 'budget' ? 1 : 0);
        const json: unknown = JSON.parse(
          await readFile(`${output}.json`, 'utf8'),
        );
        expect(json).toMatchObject({
          coverage: { cellsPlanned: 2 },
          publication: {
            qualityAcceptance: { status: 'not-assessed' },
            consistency: { indexReliable: true },
          },
        });
        const markdown = await readFile(`${output}.md`, 'utf8');
        expect(markdown).toContain('全部分组明细');
        const files = await readdir(`${output}.details`);
        expect(files).toHaveLength(1);
        const details = await readFile(
          join(`${output}.details`, files[0] ?? ''),
          'utf8',
        );
        for (const view of ['format-clean-main', 'format-build-main']) {
          const id = `${view}~${kind === 'unsupported' ? 'chat-a' : 'decision-a'}~decision~r1`;
          expect(markdown).toContain(id);
          expect(details).toContain(id);
        }
        expect(details).toContain(
          kind === 'complete' ? '| reviewed | reviewed |' : '无记录',
        );
      });
    },
  );
  it.each(['--mode', '--channel'] as const)(
    'rejects invalid %s before creating or dispatching a run',
    async (flag) => {
      await withWorkflowArea(async (area) => {
        await area.write();
        expect(
          await area.cli(['run', area.planPath, '--report', flag, 'typo']),
        ).toBe(2);
        await expect(stat(area.runDirectory)).rejects.toMatchObject({
          code: 'ENOENT',
        });
        expect(area.log.join('\n')).toContain(`${flag} takes`);
      });
    },
  );
  it.each(['--mode', '--channel'] as const)(
    'rejects invalid %s on resume without changing any saved evidence',
    async (flag) => {
      await withWorkflowArea(async (area) => {
        await area.write();
        expect(await area.cli(['run', area.planPath])).toBe(0);
        const before = await inventory(area.runDirectory);
        expect(
          await area.cli([
            'run',
            area.planPath,
            '--resume',
            '--report',
            flag,
            'typo',
          ]),
        ).toBe(2);
        expect(await inventory(area.runDirectory)).toEqual(before);
        expect(area.log.join('\n')).toContain(`${flag} takes`);
      });
    },
  );
  it('a claim-refused resume does not publish or change active evidence even with force', async () => {
    await withWorkflowArea(async (area) => {
      await area.write();
      expect(await area.cli(['run', area.planPath])).toBe(0);
      const before = await readFile(
        join(area.runDirectory, 'index.json'),
        'utf8',
      );
      const release = await claimRun(area.runDirectory);
      const lock = await readFile(join(area.runDirectory, 'run.lock'), 'utf8');
      try {
        expect(
          await area.cli([
            'run',
            area.planPath,
            '--resume',
            '--report',
            '--force',
          ]),
        ).toBe(1);
        await expect(
          readFile(join(area.runDirectory, 'report.json')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(
          await readFile(join(area.runDirectory, 'index.json'), 'utf8'),
        ).toBe(before);
        expect(
          await readFile(join(area.runDirectory, 'run.lock'), 'utf8'),
        ).toBe(lock);
      } finally {
        await release();
      }
    });
  });
});
