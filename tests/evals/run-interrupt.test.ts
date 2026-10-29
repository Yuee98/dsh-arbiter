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

describe('an interrupted run', () => {
  it('stops dispatch, records the cells it never started and says so', async () => {
    const cases = await allCaseIds();
    expect(cases.length).toBeGreaterThan(20);
    await withArea(async (area) => {
      // One worker, so the run is still working when the interrupt lands.
      const plan = {
        ...planOf({ split: 'all', caseIds: [...cases] }),
        fixture: 'fixture.json',
      };
      await area.write('plan.json', {
        ...plan,
        bounds: { ...plan.bounds, concurrency: 1, maxAttempts: 200 },
      });
      await area.write(
        'fixture.json',
        fixtureOf(
          Object.fromEntries(
            cases.map((caseId) => [
              cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
              fixtureCell({ chat: [chatAnswer(2, 10)] }),
            ]),
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
      // Long enough for the entry point to install its handler, short enough that the
      // grid is still being walked.
      await new Promise((resolve) => setTimeout(resolve, 250));
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
      expect(read.artifact.index.cells).toHaveLength(cases.length);
      expect(
        read.artifact.index.cells.filter((cell) => cell.status === 'not-run')
          .length,
      ).toBeGreaterThan(0);
      // Nothing claims to have run without leaving evidence.
      expect(read.artifact.missing).toEqual([]);
    });
  }, 60_000);
});
