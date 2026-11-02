import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runCli } from '../../../evals/src/cli/run.js';
import { cellGrid } from '../../../evals/src/run/plan.js';
import type { RunPlan } from '../../../evals/src/run/types.js';
import { collectionOf, workflow } from '../fixtures/workflow.js';
import {
  chatAnswer,
  decisionAnswer,
  decisionTarget,
  fixtureCell,
  fixtureOf,
} from './run.js';

const root = fileURLToPath(new URL('../../../', import.meta.url));

export async function workflowArea() {
  const directory = await mkdtemp(join(tmpdir(), 'arbiter-workflow-run-'));
  const datasetPath = join(directory, 'dataset');
  const sourcePath = join(datasetPath, 'dev/f01/workflows.json');
  await mkdir(join(datasetPath, 'dev/f01'), { recursive: true });
  const source = workflow({ lineageId: 'independent-lineage' });
  await writeFile(sourcePath, JSON.stringify(collectionOf(source)));
  const runDirectory = join(directory, 'run');
  const fixturePath = join(directory, 'fixture.json');
  const planPath = join(directory, 'plan.json');
  const plan: RunPlan = {
    planVersion: 'eval-run-plan-v1',
    datasetId: 'workflow-test',
    datasetPath,
    split: 'dev',
    transport: 'offline',
    protocols: ['decision'],
    targets: [decisionTarget()],
    repeats: 1,
    context: { targetInputTokens: 6000, maxInputTokens: 10000 },
    bounds: {
      concurrency: 2,
      timeoutMs: 5000,
      maxAttempts: 8,
      maxInputTokens: 10000,
    },
    fixture: fixturePath,
    notes: [],
    workflow: {
      contentSet: 'workflows-v1',
      points: source.points.slice(0, 2).map((point) => ({
        group: 'f01',
        rootId: source.rootId,
        pointId: point.pointId,
        viewId: point.primaryViewId,
      })),
      input: { customRules: '', projectRules: { kind: 'disabled' } },
    },
    resource: { runDirectory, maxAttempts: 8, maxEstimatedInputTokens: 80000 },
  };
  const log: string[] = [];
  return {
    root,
    directory,
    datasetPath,
    sourcePath,
    source,
    runDirectory,
    planPath,
    fixturePath,
    plan,
    log,
    async write(next: RunPlan = plan): Promise<void> {
      await writeFile(planPath, JSON.stringify(next));
      await writeFile(
        fixturePath,
        JSON.stringify(
          fixtureOf(
            Object.fromEntries(
              cellGrid(next)
                .cells.filter((cell) => cell.supported)
                .map((cell) => [
                  cell.cellId,
                  fixtureCell({
                    decision: [decisionAnswer({ '1': 1 }, { '9': 1 })],
                    chat: [chatAnswer(2, 10)],
                  }),
                ]),
            ),
          ),
        ),
      );
    },
    async cli(args: readonly string[]): Promise<number> {
      return runCli(args, {
        root,
        out: (line) => log.push(line),
        err: (line) => log.push(line),
        env: () => {
          throw new Error('offline commands must not read a credential');
        },
      });
    },
    async remove(): Promise<void> {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

export async function withWorkflowArea(
  body: (area: Awaited<ReturnType<typeof workflowArea>>) => Promise<void>,
): Promise<void> {
  const area = await workflowArea();
  try {
    await body(area);
  } finally {
    await area.remove();
  }
}
