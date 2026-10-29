/**
 * Interrupting a run from the command line.
 *
 * This is the one behaviour that cannot be tested through a function call: whether the
 * process hands its signal to the runner is a property of the entry point. So the test
 * spawns the real binary on a plan big enough to still be running when the signal
 * arrives, and then reads the directory it left behind.
 *
 * What it pins is the difference between stopping and abandoning. A Ctrl-C must finish
 * the cells in flight and record every cell it never started, so the artifact says
 * "cancelled" instead of looking like a run that is still going.
 */

import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { readRun } from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { readDataset } from '../../evals/src/data/read.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { REVIEW_CONTRACT_VERSION } from '../../src/review-contract/index.js';
import {
  cellIdOf,
  chatAnswer,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

const REPOSITORY = new URL('../../', import.meta.url).pathname;
const checkers = await compileRunCheckers();

/** Every case the dataset publishes, so the run cannot finish before the signal. */
async function allCaseIds(): Promise<readonly string[]> {
  const raw = await readDataset(join(REPOSITORY, 'evals/datasets/core-v1'));
  const inspection = inspectDataset(raw, await compileCheckers(), {
    contract: REVIEW_CONTRACT_VERSION,
    rubric: 'review-rubric-v1',
  });
  return inspection.cases.map((entry) => entry.document.caseId);
}

/**
 * Wait until a run directory has published its index.
 *
 * The index is written before the first cell, so its presence means dispatch has started.
 * Polling for it is what makes the test independent of machine speed.
 */
async function waitForIndex(directory: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const present = await readFile(join(directory, 'index.json'), 'utf8').then(
      () => true,
      () => false,
    );
    if (present) return;
    if (Date.now() > deadline) {
      throw new Error('the run never published its index');
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe('an interrupted run', () => {
  it('stops dispatch, records the cells it never started and says so', async () => {
    const cases = await allCaseIds();
    expect(cases.length).toBeGreaterThan(20);
    await withArea(async (area) => {
      // Enough repeats that the grid cannot be walked in the moment between the index
      // being written and the signal arriving, and one worker so the run is sequential.
      const repeats = 12;
      const plan = {
        ...planOf({ split: 'all', caseIds: [...cases], repeats }),
        fixture: 'fixture.json',
      };
      await area.write('plan.json', {
        ...plan,
        bounds: { ...plan.bounds, concurrency: 1, maxAttempts: 10_000 },
      });
      await area.write(
        'fixture.json',
        fixtureOf(
          Object.fromEntries(
            cases.flatMap((caseId) =>
              Array.from({ length: repeats }, (_, index) => [
                cellIdOf({
                  caseId,
                  targetId: 'chat-a',
                  protocol: 'chat',
                  repeat: index + 1,
                }),
                fixtureCell({ chat: [chatAnswer(2, 10)] }),
              ]),
            ),
          ),
        ),
      );

      const child = spawn(
        process.execPath,
        [
          'evals/src/cli.ts',
          'run',
          join(area.path, 'plan.json'),
          '--dir',
          join(area.path, 'run'),
        ],
        { cwd: REPOSITORY, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const closed = new Promise<number | null>((resolve) => {
        child.on('close', resolve);
      });
      // Wait for the run to have published its index, which happens before the first
      // cell. Signalling then is deterministic: dispatch has started, and the grid is far
      // too large to finish in the moment it takes to send the signal. A fixed sleep would
      // instead race a fast machine and pass or fail on timing.
      await waitForIndex(join(area.path, 'run'));
      child.kill('SIGINT');
      const code = await closed;

      // The handler ran, which is the only proof that the signal reached the runner.
      expect(stderr).toContain('interrupt received');
      // A cancelled run is not a successful one.
      expect(code).toBe(1);

      const read = await readRun(join(area.path, 'run'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.artifact.index.status).toBe('cancelled');
      // The whole plan is still stated: the cells that never started are recorded, not
      // dropped, so the directory describes an experiment rather than a fragment of one.
      expect(read.artifact.index.cells).toHaveLength(cases.length * repeats);
      expect(
        read.artifact.index.cells.filter((cell) => cell.status === 'not-run')
          .length,
      ).toBeGreaterThan(0);
      // Nothing claims to have run without leaving evidence.
      expect(read.artifact.missing).toEqual([]);
    });
  }, 60_000);
});
