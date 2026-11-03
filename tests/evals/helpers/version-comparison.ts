/** Two real offline executions; all references are explicit synthetic test fixtures. */
import { copyFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { defaultSettings } from '../../../evals/src/metrics/index.js';
import { observeRun } from '../../../evals/src/metrics/observe.js';
import { readReferenceSnapshot } from '../../../evals/src/metrics/reference-snapshot.js';
import type { ReferenceSnapshot } from '../../../evals/src/metrics/reference-snapshot.js';
import type { RunPlan, RunFixture } from '../../../evals/src/run/types.js';
import { prepareComparison } from '../../../evals/src/report/compare.js';
import { reportRun } from '../../../evals/src/report/command.js';
import type { ReportCommand } from '../../../evals/src/report/command.js';
import { replayReferences } from './replay-workflow.js';
import { approvedTarget } from '../fixtures/documents.js';
import type { workflowArea } from './workflow-run.js';

type WorkflowArea = Awaited<ReturnType<typeof workflowArea>>;
export async function savedRun(
  area: WorkflowArea,
  name: string,
  plan: RunPlan = area.plan,
  fixture?: RunFixture,
) {
  const directory = join(area.directory, name);
  const next = {
    ...plan,
    resource: {
      ...plan.resource,
      runDirectory: directory,
      maxAttempts: plan.resource?.maxAttempts ?? 8,
      maxEstimatedInputTokens: plan.resource?.maxEstimatedInputTokens ?? 80000,
    },
  };
  await area.write(next);
  if (fixture !== undefined)
    await writeFile(area.fixturePath, JSON.stringify(fixture));
  const exit = await area.cli(['run', area.planPath, '--dir', directory]);
  if (exit !== 0) throw new Error(area.log.join('\n'));
  return directory;
}
export async function syntheticReferences(
  area: WorkflowArea,
  name: string,
  plan: RunPlan,
  behaviour: 'allow' | 'deny' = 'allow',
) {
  const paths = await replayReferences(area.root, area.directory, plan);
  const result: string[] = [];
  for (const [index, path] of paths.entries()) {
    const snapshot = await readReferenceSnapshot(path);
    const entries: ReferenceSnapshot['entries'][number][] =
      snapshot.entries.map((entry) => {
        if (entry.reference === null)
          throw new Error('fixture reference missing');
        return {
          ...entry,
          reference: {
            ...entry.reference,
            target: approvedTarget({
              allowed: { risk: [2], authorization: [10] },
              behaviourReference: behaviour,
            }),
          },
        };
      });
    const destination = join(area.directory, `${name}-${String(index)}.json`);
    await copyFile(path, destination);
    await writeFile(destination, JSON.stringify({ ...snapshot, entries }));
    result.push(destination);
  }
  return result;
}
export async function compared(
  area: WorkflowArea,
  baseline: string,
  current: string,
  references: readonly string[],
  baselineReferences: readonly string[] = references,
) {
  const settings = { ...defaultSettings(area.root), references };
  const read = await observeRun({
    directory: current,
    root: area.root,
    dataset: settings.dataset,
    references,
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  const command: ReportCommand = {
    directory: current,
    compare: baseline,
    references,
    baselineReferences,
    output: join(area.directory, 'comparison'),
    dataset: null,
    mode: 'ask',
    channel: 'available',
    force: true,
  };
  const prepared = await prepareComparison({
    command,
    settings,
    current: read.observation,
  });
  if (prepared === null) throw new Error('comparison missing');
  const errors: string[] = [];
  const exit = await reportRun(
    { root: area.root, out: () => {}, err: (line) => errors.push(line) },
    command,
  );
  const formats = await Promise.all(
    ['json', 'md', 'html'].map((extension) =>
      readFile(`${command.output ?? ''}.${extension}`, 'utf8'),
    ),
  );
  return { section: prepared.comparison, exit, errors, formats, command };
}
