import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { defaultSettings } from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { prepareComparison } from '../../evals/src/report/compare.js';
import { reportRun } from '../../evals/src/report/command.js';
import { approvedTarget, VERSIONS } from '../evals/fixtures/documents.js';
import {
  coreCases,
  runPlan,
  unlabelledCoreDataset,
  withArea,
  REPOSITORY_ROOT,
} from '../evals/helpers/report-run.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from '../evals/helpers/run.js';

describe(
  'legacy saved responses under revised dataset labels',
  { timeout: 60_000 },
  () => {
    it('reuses only matching input, retains original evaluation and names both dataset inputs', async () => {
      await withArea(async (area) => {
        const original = await unlabelledCoreDataset(area);
        const revised = join(area.path, 'revised');
        await cp(original, revised, { recursive: true });
        const id = 'read-named-source-file';
        const entry = (await coreCases(original)).cases.find(
          (item) => item.caseId === id,
        );
        if (entry === undefined) throw new Error('legacy fixture case missing');
        for (const [directory, behaviour] of [
          [original, 'deny'],
          [revised, 'allow'],
        ] as const) {
          await mkdir(join(directory, 'labels'), { recursive: true });
          await writeFile(
            join(directory, 'labels', `${id}.json`),
            JSON.stringify({
              caseId: id,
              inputHash: inputHashOf(entry.input),
              versions: VERSIONS,
              target: approvedTarget({
                allowed:
                  behaviour === 'deny'
                    ? { risk: [10], authorization: [1] }
                    : { risk: [2], authorization: [10] },
                behaviourReference: behaviour,
              }),
            }),
          );
        }
        const target = chatTarget();
        const fixture = fixtureOf({
          [cellIdOf({
            caseId: id,
            targetId: target.targetId,
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        });
        const run = (directory: string, dataset: string) =>
          runPlan({
            directory,
            plan: planOf({
              datasetPath: dataset,
              caseIds: [id],
              protocols: ['chat'],
              targets: [target],
            }),
            fixture,
            datasetPath: dataset,
          });
        const baseline = await run(join(area.path, 'baseline'), original);
        const current = await run(join(area.path, 'current'), revised);
        const settings = {
          ...defaultSettings(REPOSITORY_ROOT),
          dataset: { kind: 'path' as const, path: revised },
        };
        const read = await observeRun({
          directory: current,
          root: REPOSITORY_ROOT,
          dataset: settings.dataset,
        });
        if (!read.ok) throw new Error(read.problems.join('; '));
        const command = {
          directory: current,
          compare: baseline,
          baselineDataset: original,
          dataset: revised,
          output: join(area.path, 'comparison'),
          force: true,
          mode: 'ask',
          channel: 'available',
        };
        const oldBytes = await readFile(join(original, 'labels', `${id}.json`));
        const result = await prepareComparison({
          command,
          settings,
          current: read.observation,
        });
        expect(result?.comparison).toMatchObject({
          pairedConditions: 1,
          baseline: {
            datasetInput: original,
            commonDatasetInput: revised,
            original: { matched: 0 },
            common: { matched: 1 },
          },
          behaviour: { paired: 1, unchanged: 1, improved: 0 },
        });
        const errors: string[] = [];
        expect(
          await reportRun(
            {
              root: REPOSITORY_ROOT,
              out: () => {},
              err: (line) => errors.push(line),
            },
            command,
          ),
        ).toBe(0);
        expect(errors).toEqual([]);
        expect(await readFile(join(original, 'labels', `${id}.json`))).toEqual(
          oldBytes,
        );
      });
    });
  },
);
