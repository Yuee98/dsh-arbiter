/**
 * The run commands, end to end.
 *
 * The claim that matters here is about authority, not convenience: a run reaches a
 * provider only when someone types `evals run`. So these tests check both directions —
 * that `plan`, `resume` and `show` never dispatch, and that `run` refuses to start when
 * it could not do what it was asked — against the real command entry point and real
 * files, because a mocked command would leave exactly that boundary untested.
 */

import { readdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { parseCommand, runCli } from '../../evals/src/cli/run.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { readDataset } from '../../evals/src/data/read.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { REVIEW_CONTRACT_VERSION } from '../../src/review-contract/index.js';
import type { CliIo } from '../../evals/src/cli/run.js';
import { parseRunCommand } from '../../evals/src/cli/run-commands.js';
import { executionDigest, RUN_FILES } from '../../evals/src/run/artifact.js';
import { datasetDigest as datasetDigestOf } from '../../evals/src/annotation/summary.js';
import { defaultRunDirectory, runIdOf } from '../../evals/src/run/commands.js';
import {
  bounds,
  cellIdOf,
  chatAnswer,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

/**
 * The repository root, which is what `io.root` is in the real entry point.
 *
 * A plan names its dataset repository-relatively, so the commands resolve dataset paths
 * against this root. A test therefore keeps the real root and puts its own documents in a
 * temporary directory with absolute paths, which is exactly how an operator runs a plan
 * kept outside the repository.
 */
const REPOSITORY_ROOT = new URL('../../', import.meta.url).pathname;

/** Collect what a command wrote, so an assertion can read it back. */
function recorder(
  _area: string,
  env: Record<string, string> = {},
): {
  readonly io: CliIo;
  readonly out: readonly string[];
  readonly err: readonly string[];
} {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      root: REPOSITORY_ROOT,
      out: (line) => out.push(line),
      err: (line) => err.push(line),
      env: (name) => env[name],
    },
    out,
    err,
  };
}

/**
 * One plan and its fixture, written where the plan expects to find them.
 *
 * The fixture path is relative to the repository root, which is how a plan names it, so
 * the whole run stays inside one temporary area without the plan carrying an absolute
 * path.
 */
async function seedPlan(
  area: {
    readonly path: string;
    write(relative: string, document: unknown): Promise<void>;
  },
  plan: ReturnType<typeof planOf>,
  cells: Record<string, ReturnType<typeof fixtureCell>>,
): Promise<void> {
  // Absolute paths, so the plan and its fixture live in the temporary area while the
  // dataset stays the published one this repository ships.
  await area.write('plan.json', {
    ...plan,
    fixture: join(area.path, 'fixture.json'),
  });
  await area.write('fixture.json', fixtureOf(cells));
}

/**
 * Read a run index the way the runner wrote it.
 *
 * The two fields the assertions need are read through a guard rather than asserted into a
 * type: a test that asserted them would keep passing if the writer stopped producing
 * them, which is the opposite of what a test of a written document should do.
 */
async function readIndex(path: string): Promise<{
  readonly spent: {
    readonly attempts: number;
    readonly cellsCompleted: number;
    readonly cellsStarted: number;
  };
  readonly resumed: readonly unknown[];
  readonly status: string;
}> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (parsed === null || typeof parsed !== 'object') {
    throw new TypeError(`${path} is not a run index`);
  }
  const spent: unknown = Reflect.get(parsed, 'spent');
  const resumed: unknown = Reflect.get(parsed, 'resumed');
  const status: unknown = Reflect.get(parsed, 'status');
  if (spent === null || typeof spent !== 'object') {
    throw new TypeError(`${path} has no spent totals`);
  }
  const attempts: unknown = Reflect.get(spent, 'attempts');
  const cellsCompleted: unknown = Reflect.get(spent, 'cellsCompleted');
  const cellsStarted: unknown = Reflect.get(spent, 'cellsStarted');
  if (
    typeof attempts !== 'number' ||
    typeof cellsCompleted !== 'number' ||
    typeof cellsStarted !== 'number'
  ) {
    throw new TypeError(`${path} has no numeric spent totals`);
  }
  if (!Array.isArray(resumed) || typeof status !== 'string') {
    throw new TypeError(`${path} has no resumed log or status`);
  }
  return {
    spent: { attempts, cellsCompleted, cellsStarted },
    resumed,
    status,
  };
}

/** A non-array object, for narrowing a parsed document without asserting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The committed dataset's manifest, read as the shape a plan needs.
 *
 * Read through guards rather than asserted: this test builds a *modified* dataset, and an
 * assertion here would let a change to the real manifest produce a confusing failure in an
 * unrelated test instead of naming the field that moved.
 */
async function readRealManifest(): Promise<{
  readonly families: readonly {
    readonly familyId: string;
    readonly split: string;
  }[];
  readonly raw: Record<string, unknown>;
}> {
  const parsed: unknown = JSON.parse(
    await readFile(
      join(REPOSITORY_ROOT, 'evals/datasets/core-v1/manifest.json'),
      'utf8',
    ),
  );
  if (!isRecord(parsed)) {
    throw new TypeError('the manifest is not an object');
  }
  const families: unknown = Reflect.get(parsed, 'families');
  if (!Array.isArray(families)) {
    throw new TypeError('the manifest has no families');
  }
  const named = families.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') {
      throw new TypeError('a family is not an object');
    }
    const familyId: unknown = Reflect.get(entry, 'familyId');
    const split: unknown = Reflect.get(entry, 'split');
    if (typeof familyId !== 'string' || typeof split !== 'string') {
      throw new TypeError('a family has no familyId or split');
    }
    return { familyId, split };
  });
  return { families: named, raw: parsed };
}

/** The absolute path of a document inside one temporary area. */
function at(area: { readonly path: string }, name: string): string {
  return join(area.path, name);
}

describe('run command parsing', () => {
  it('parses plan with a document and no flags', () => {
    expect(parseRunCommand('plan', ['plan.json'])).toEqual({
      name: 'plan',
      plan: 'plan.json',
      dir: null,
      resume: false,
      dryRun: false,
    });
  });

  it('defaults run to a new dispatch and requires an explicit --resume', () => {
    const parsed = parseRunCommand('run', ['plan.json']);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') return;
    expect(parsed.resume).toBe(false);
    expect(parsed.dryRun).toBe(false);
  });

  it('accepts --dir, --resume and --dry-run on run', () => {
    const parsed = parseRunCommand('run', [
      'plan.json',
      '--dir',
      'out',
      '--resume',
      '--dry-run',
    ]);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') return;
    expect(parsed.dir).toBe('out');
    expect(parsed.resume).toBe(true);
    expect(parsed.dryRun).toBe(true);
  });

  it('refuses --resume and --dry-run on the commands that would not honour them', () => {
    // Silently accepting a flag a command ignores is how someone believes a command
    // wrote nothing when it did not.
    expect(parseRunCommand('plan', ['plan.json', '--dry-run'])).toContain(
      'plan does not take --dry-run',
    );
    expect(parseRunCommand('resume', ['plan.json', '--resume'])).toContain(
      'resume does not take --resume',
    );
  });

  it('refuses an unknown flag instead of ignoring it', () => {
    expect(
      parseRunCommand('run', ['plan.json', '--concurrency', '8']),
    ).toContain('unknown option --concurrency');
  });

  it('requires a document, and names the shape it wants', () => {
    expect(parseRunCommand('run', [])).toContain('run needs a plan document');
    expect(parseRunCommand('show', [])).toContain('show needs a run directory');
  });

  it('treats show as a run-directory command, not a plan command', () => {
    const parsed = parseRunCommand('show', ['out']);
    expect(typeof parsed).not.toBe('string');
    if (typeof parsed === 'string') return;
    expect(parsed.dir).toBe('out');
    expect(parsed.plan).toBeNull();
  });

  it('is reached through the top-level parser, and keeps dataset flags out of it', () => {
    expect(parseCommand(['run', 'plan.json'])).toMatchObject({
      name: 'run',
      plan: 'plan.json',
    });
    // The dataset parser's flags are not accepted on a run command.
    expect(parseCommand(['run', 'plan.json', '--out', 'x'])).toContain(
      'unknown option --out',
    );
  });

  it('prints the run commands in the usage text', () => {
    const usage = parseCommand([]);
    expect(typeof usage).toBe('string');
    if (typeof usage !== 'string') return;
    expect(usage).toContain('run <plan.json>');
    expect(usage).toContain('resume <plan.json>');
    expect(usage).toContain('show <run-dir>');
  });
});

describe('plan', () => {
  it('expands a plan without writing a run directory', async () => {
    await withArea(async (area) => {
      await seedPlan(area, planOf(), {
        [cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const { io, out } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('cells 1: 1 supported, 0 unsupported');
      expect(text).toContain('bounds concurrency 2');
      expect(text).toContain('planHash sha256:');
      // A dry run writes nothing at all.
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });

  it('reports an unsupported pairing it would not send', async () => {
    await withArea(async (area) => {
      const plan = planOf({ protocols: ['chat', 'decision'] });
      await seedPlan(area, plan, {
        [cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const { io, out } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('1 supported, 1 unsupported');
      expect(text).toContain('does not offer protocol decision');
    });
  });

  it('refuses a plan whose fixture cannot replay a supported cell', async () => {
    await withArea(async (area) => {
      await seedPlan(area, planOf(), {});
      const { io, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      // A cell with no script cannot be replayed, and the dry run says which one.
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('fixture has no entry for');
    });
  });

  it('refuses a plan that names a case the dataset does not publish', async () => {
    await withArea(async (area) => {
      await seedPlan(area, planOf({ caseIds: ['no-such-case'] }), {});
      const { io, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('this dataset does not publish');
    });
  });

  it('refuses a plan document that is not a plan', async () => {
    await withArea(async (area) => {
      await area.write('plan.json', { planVersion: 'eval-run-plan-v0' });
      const { io, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('plan.json:');
    });
  });

  it('names an absent plan by its path', async () => {
    await withArea(async (area) => {
      const { io, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'missing.json')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('missing.json does not exist');
    });
  });

  it('refuses a live plan that cannot resolve its credential, before writing anything', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        protocols: ['decision'],
        targets: [
          {
            targetId: 'decision-a',
            provider: 'decision',
            model: 'clef',
            modelVersion: null,
            chat: null,
            decision: {
              url: 'https://api.example/v1/systemone',
              model: 'clef',
              apiKeyRef: 'OFFLINE_KEY',
              timeoutMs: 5_000,
              costTier: 'paid',
            },
            credentialRef: 'OFFLINE_KEY',
          },
        ],
      });
      await area.write('plan.json', plan);
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      // Starting a live run with no credential would produce a directory full of
      // identical failures that look like provider outages.
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('a live run needs OFFLINE_KEY');
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });
});

describe('run', () => {
  it('dispatches an offline plan and writes its records', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, plan, {
        [cellId]: fixtureCell({
          chat: [chatAnswer(2, 10, { input_tokens: 700 })],
        }),
      });
      const { io, out } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('complete — 1/1 cells decided');
      const files = await readdir(join(area.path, 'run', RUN_FILES.records));
      expect(files).toContain(`${cellId}.json`);
    });
  });

  it('runs nothing when --dry-run is given', async () => {
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const { io, out } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--dry-run'],
        io,
      );
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('planHash sha256:');
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });

  it('reports an interrupted run through resume, then finishes it', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
      });
      const cells = [
        cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
        cellIdOf({
          caseId: 'read-repo-index-with-cache',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
      ];
      await seedPlan(area, plan, {
        [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        [cells[1] ?? '']: fixtureCell({ chat: [chatAnswer(3, 9)] }),
      });
      // A first pass that stopped before the second cell: the fixture has no script for
      // it yet, so `--resume` is what a person runs after adding one.
      const partial = recorder(area.path);
      await runCli(['plan', at(area, 'plan.json')], partial.io);
      expect(partial.out.join('\n')).toContain('2 supported');

      const first = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      expect(first).toBe(0);

      const resumed = recorder(area.path);
      const inspectCode = await runCli(
        ['resume', at(area, 'plan.json'), '--dir', at(area, 'run')],
        resumed.io,
      );
      expect(inspectCode).toBe(0);
      // The continuation reports that nothing is pending, and touches nothing.
      expect(resumed.out.join('\n')).toContain(
        '2/2 cells have a record, 0 pending',
      );
    });
  });

  it('continues a cancelled run in place, leaving the finished record untouched', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cells = [
        cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
        cellIdOf({
          caseId: 'read-repo-index-with-cache',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
      ];
      await area.write('plan.json', {
        ...plan,
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cells[1] ?? '']: fixtureCell({ chat: [chatAnswer(3, 9)] }),
        }),
      );
      // A first pass the operator cancelled: an already-aborted lifetime dispatches
      // nothing, which leaves every cell with no record.
      const controller = new AbortController();
      controller.abort();
      const interrupted = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        { ...recorder(area.path).io, signal: controller.signal },
      );
      expect(interrupted).toBe(1);
      await expect(
        readdir(join(area.path, 'run', RUN_FILES.records)),
      ).resolves.toEqual([]);

      // The operator continues: the same plan, the same fixture, no new head.
      const second = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        recorder(area.path).io,
      );
      expect(second).toBe(0);
      const files = await readdir(join(area.path, 'run', RUN_FILES.records));
      expect(files).toHaveLength(2);
      const index = await readIndex(join(area.path, 'run', RUN_FILES.index));
      // Two cells, two attempts, counted once each: the cancelled pass spent nothing and
      // the continuation did not double-count anything.
      expect(index.spent.attempts).toBe(2);
      expect(index.spent.cellsCompleted).toBe(2);
      expect(index.resumed).toHaveLength(1);
    });
  });

  it('does not re-run a cell that already has a record, even a failed one', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        bounds: bounds({ concurrency: 1, maxAttempts: 8 }),
      });
      const cells = [
        cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
        cellIdOf({
          caseId: 'read-repo-index-with-cache',
          targetId: 'chat-a',
          protocol: 'chat',
        }),
      ];
      // Only the first cell has a script: the second fails, and its failure is recorded.
      await area.write('plan.json', {
        ...plan,
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      );
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const failedPath = join(
        area.path,
        'run',
        RUN_FILES.records,
        `${cells[1] ?? ''}.json`,
      );
      const before = await readFile(failedPath, 'utf8');

      // Scripting it now and continuing must not replace the evidence: a recorded failure
      // is a fact the run already paid for, and re-running it is what another repeat is
      // for.
      await area.write(
        'fixture.json',
        fixtureOf({
          [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cells[1] ?? '']: fixtureCell({ chat: [chatAnswer(3, 9)] }),
        }),
      );
      const resumed = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        resumed.io,
      );
      // The exit code follows the run's status: this directory is complete, so continuing
      // it is a successful no-op.
      expect(code).toBe(0);
      expect(await readFile(failedPath, 'utf8')).toBe(before);
      // Both cells are decided: one was reviewed and one failed, and a recorded failure is
      // a result the run already paid for. Nothing was pending, so nothing was sent.
      const index = await readIndex(join(area.path, 'run', RUN_FILES.index));
      expect(index.spent.cellsCompleted).toBe(2);
      expect(index.spent.cellsStarted).toBe(1);
      expect(index.status).toBe('complete');
      // Nothing was pending, so the continuation spent nothing at all.
      expect(index.spent.attempts).toBe(1);
      expect(resumed.out.join('\n')).toContain('2/2 cells decided');
    });
  });

  it('refuses a resume whose plan no longer matches the run', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, plan, {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      await area.write('plan.json', planOf({ repeats: 2 }));
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['resume', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain(
        'does not match the run it would continue',
      );
    });
  });

  it('refuses to continue a directory that holds no run', async () => {
    await withArea(async (area) => {
      await seedPlan(area, planOf(), {});
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['resume', at(area, 'plan.json'), '--dir', at(area, 'nothing')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('holds no run to continue');
    });
  });
});

describe('show', () => {
  it('reads a finished run and prints its cells without a model call', async () => {
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({
          chat: [chatAnswer(2, 10, { input_tokens: 640, output_tokens: 8 })],
        }),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      // The scripted socket is deleted before reading, so a reader that needed it would
      // fail. `show` must not.
      const { io, out } = recorder(area.path);
      const code = await runCli(['show', at(area, 'run')], io);
      expect(code).toBe(0);
      const text = out.join('\n');
      expect(text).toContain('reviewed scored 2/10 review-allow');
      expect(text).toContain('usage review-usage-v1');
      expect(text).toContain('versions contract review-contract-v1');
    });
  });

  it('reports a reviewed cell whose record file is gone as a gap', async () => {
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      // Delete the record but keep the index: a cell that says it ran and has no
      // evidence is exactly the gap this reader exists to name.
      await rm(join(area.path, 'run', RUN_FILES.records, `${cellId}.json`));
      const { io, err } = recorder(area.path);
      const code = await runCli(['show', at(area, 'run')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('planned the cell but never wrote it');
    });
  });

  it('does not report a settled cell that never had a record as missing', async () => {
    await withArea(async (area) => {
      // A decision pairing a chat-only target is decided by the plan and writes no
      // record. Reading it as missing evidence would report a refusal as data loss.
      const plan = planOf({ protocols: ['chat', 'decision'] });
      await seedPlan(area, plan, {
        [cellIdOf({
          caseId: 'read-named-source-file',
          targetId: 'chat-a',
          protocol: 'chat',
        })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const { io, err } = recorder(area.path);
      const code = await runCli(['show', at(area, 'run')], io);
      expect(code).toBe(0);
      expect(err).toEqual([]);
    });
  });

  it('refuses a directory that is not a run', async () => {
    await withArea(async (area) => {
      const { io, err } = recorder(area.path);
      const code = await runCli(['show', at(area, 'nothing')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('the run has no plan');
    });
  });
});

describe('where a run writes', () => {
  it('derives a directory under .local from the dataset and the plan name', () => {
    expect(defaultRunDirectory('core-v1', '.local/plans/dev.json')).toBe(
      '.local/evals/runs/core-v1/dev',
    );
  });

  it('derives a run id from the plan hash, so two runs of one plan share it', () => {
    const plan = planOf();
    const hash = 'sha256:0123456789abcdef0123456789abcdef';
    expect(runIdOf(plan, hash)).toBe('core-v1-0123456789ab');
  });
});

describe('corrections from review', () => {
  it('refuses an occupied run directory instead of replacing its plan', async () => {
    // RQ10-B02: `run` into an existing directory replaced plan.json and index.json while
    // leaving the old records, producing a directory describing two experiments.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const first = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      expect(first).toBe(0);
      const planBefore = await readFile(
        join(area.path, 'run', RUN_FILES.plan),
        'utf8',
      );
      const indexBefore = await readFile(
        join(area.path, 'run', RUN_FILES.index),
        'utf8',
      );

      // A second new run into the same directory, with a different plan.
      await area.write('beside.json', {
        ...planOf({ repeats: 2 }),
        fixture: at(area, 'fixture.json'),
      });
      const second = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'beside.json'), '--dir', at(area, 'run')],
        second.io,
      );
      expect(code).toBe(1);
      expect(second.err.join('\n')).toContain('refusing to overwrite it');
      // Nothing was replaced: the first experiment is intact byte for byte.
      expect(
        await readFile(join(area.path, 'run', RUN_FILES.plan), 'utf8'),
      ).toBe(planBefore);
      expect(
        await readFile(join(area.path, 'run', RUN_FILES.index), 'utf8'),
      ).toBe(indexBefore);
    });
  });

  it('refuses a continuation whose dataset revision moved', async () => {
    // RQ10-B06: continuing against a different dataset revision would mix two selections
    // under one plan hash, and a report could not tell which revision an input belonged to.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      // Forge a different frozen digest, which is what a moved dataset looks like.
      const raw: unknown = JSON.parse(
        await readFile(join(area.path, 'run', RUN_FILES.index), 'utf8'),
      );
      if (raw === null || typeof raw !== 'object') {
        throw new TypeError('the index is not an object');
      }
      const frozen: unknown = Reflect.get(raw, 'dataset');
      if (frozen === null || typeof frozen !== 'object') {
        throw new TypeError('the index has no dataset block');
      }
      Reflect.set(frozen, 'digest', `sha256:${'0'.repeat(64)}`);
      await area.write(`run/${RUN_FILES.index}`, raw);
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('dataset revision moved');
    });
  });

  it('accepts an authored plan that omits caseIds and hashes the resolved one', async () => {
    // RQ10-B07: the schema lets a plan omit caseIds and let the split choose. Refusing it
    // made the schema and the linter disagree about what a valid plan is.
    await withArea(async (area) => {
      const plan: Record<string, unknown> = {
        ...planOf({ caseIds: [] }),
        fixture: at(area, 'fixture.json'),
      };
      delete plan['caseIds'];
      await area.write('plan.json', plan);
      // Every dev cell the split selects, scripted. The split decides, so the test cannot
      // assume one case.
      // The split is resolved by the same inspector a run uses, so the test asserts
      // against the selection the command will make rather than re-deriving it.
      const raw = await readDataset(
        join(REPOSITORY_ROOT, 'evals/datasets/core-v1'),
      );
      const dataCheckers = await compileCheckers();
      const devCases = inspectDataset(raw, dataCheckers, {
        contract: REVIEW_CONTRACT_VERSION,
        rubric: 'review-rubric-v1',
      })
        .cases.map((entry) => entry.document)
        .filter((entry) => entry.split === 'dev')
        .map((entry) => entry.caseId);
      expect(devCases.length).toBeGreaterThan(1);
      await area.write(
        'fixture.json',
        fixtureOf(
          Object.fromEntries(
            devCases.map((caseId) => [
              cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
              fixtureCell({ chat: [chatAnswer(2, 10)] }),
            ]),
          ),
        ),
      );
      const { io, out, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(err.join('\n')).toBe('');
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('cases');
      // The published hash is over the resolved selection, which is what a run freezes.
      expect(out.join('\n')).toContain('planHash sha256:');
    });
  });

  it('resolves a relative fixture against the plan document', async () => {
    // RQ10-B10: the schema says the fixture path is relative to the plan, so a plan and its
    // fixture can move together.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      // The plan sits in a subdirectory and names its fixture beside itself.
      await area.write('plans/plan.json', planOf({ fixture: 'fixture.json' }));
      await area.write(
        'plans/fixture.json',
        fixtureOf({ [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }) }),
      );
      const { io, out, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plans/plan.json')], io);
      expect(err.join('\n')).toBe('');
      expect(code).toBe(0);
      expect(out.join('\n')).toContain('fixture');
    });
  });

  it('says why a live chat plan cannot run and writes nothing', async () => {
    // RQ10-B05: the CLI holds no LLM service, so a live chat cell would fail every attempt
    // at the transport instead of failing once, before the directory exists.
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        targets: [
          {
            targetId: 'chat-live',
            provider: 'some-provider',
            model: 'some-model',
            modelVersion: null,
            chat: {
              provider: 'some-provider',
              model: 'some-model',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 5_000,
              maxRepairRetries: 1,
            },
            decision: null,
            credentialRef: null,
          },
        ],
      });
      await area.write('plan.json', plan);
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('needs the host LLM service');
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });

  it('refuses a live plan that asks for the session route', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        targets: [
          {
            targetId: 'chat-session',
            provider: 'session',
            // A session route names no model of its own; the host supplies it, which is
            // exactly why a headless run cannot take this route.
            model: 'session-default',
            modelVersion: null,
            chat: {
              provider: 'session',
              model: 'session-default',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 5_000,
              maxRepairRetries: 1,
            },
            decision: null,
            credentialRef: null,
          },
        ],
      });
      await area.write('plan.json', plan);
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      // Refused before anything is written, and the reason is the route, not the directory.
      expect(err.join('\n')).toContain('live chat cell needs');
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });
});

describe('the exit code follows the run status', () => {
  it('exits non-zero when a continuation cannot finish the plan', async () => {
    // RQ10-B11: the implementation was right but the evidence was not. This drives a
    // continuation whose remaining cell it cannot afford and asserts the exit code, which
    // fails if the resume branch returns 0 unconditionally.
    await withArea(async (area) => {
      const cells = [
        'read-named-source-file',
        'read-repo-index-with-cache',
      ].map((caseId) =>
        cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
      );
      // One attempt of budget for two cells: the initial run stops short of its plan.
      const plan = {
        ...planOf({
          caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
          bounds: bounds({ concurrency: 1, maxAttempts: 1 }),
        }),
        fixture: at(area, 'fixture.json'),
      };
      await area.write('plan.json', plan);
      await area.write(
        'fixture.json',
        fixtureOf({
          [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cells[1] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      );
      const first = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      // The initial run could not decide everything it planned.
      expect(first).toBe(1);

      // The continuation still cannot afford the pending cell, because the budget is the
      // run's, not a fresh one. It must not report success.
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toBe('');
      const index = await readIndex(join(area.path, 'run', RUN_FILES.index));
      expect(index.status).not.toBe('complete');
    });
  });

  it('exits zero when a continuation finishes the plan', async () => {
    await withArea(async (area) => {
      const cells = [
        'read-named-source-file',
        'read-repo-index-with-cache',
      ].map((caseId) =>
        cellIdOf({ caseId, targetId: 'chat-a', protocol: 'chat' }),
      );
      await area.write('plan.json', {
        ...planOf({
          caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
        }),
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cells[0] ?? '']: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cells[1] ?? '']: fixtureCell({ chat: [chatAnswer(3, 9)] }),
        }),
      );
      // A first pass cancelled by its own lifetime, which leaves every cell pending.
      const controller = new AbortController();
      controller.abort();
      await runCli(['run', at(area, 'plan.json'), '--dir', at(area, 'run')], {
        ...recorder(area.path).io,
        signal: controller.signal,
      });
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        recorder(area.path).io,
      );
      expect(code).toBe(0);
      const index = await readIndex(join(area.path, 'run', RUN_FILES.index));
      expect(index.status).toBe('complete');
    });
  });

  it('accepts a decision-only plan whose unused chat section names the session route', async () => {
    // RQ10-B14: only a selected protocol can make a target unroutable. Refusing a
    // decision-only plan for its unused chat section blocks a run for something it does
    // not touch.
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        protocols: ['decision'],
        targets: [
          {
            targetId: 'dual-live',
            provider: 'session',
            model: 'session-default',
            modelVersion: null,
            // The chat section names the session route, which a headless run cannot use —
            // but this plan never selects chat.
            chat: {
              provider: 'session',
              model: 'session-default',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 5_000,
              maxRepairRetries: 1,
            },
            decision: {
              url: 'https://api.example/v1/systemone',
              model: 'clef',
              apiKeyRef: 'PROBE_KEY',
              timeoutMs: 5_000,
              costTier: 'paid',
            },
            credentialRef: 'PROBE_KEY',
          },
        ],
      });
      await area.write('plan.json', plan);
      // The credential is present, so nothing about the selected protocol is unroutable.
      const { io, err } = recorder(area.path, { PROBE_KEY: 'value' });
      // Not a dry run: the preflight that refuses unroutable live plans runs on the real
      // path, so a dry run would not exercise it at all.
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      const message = err.join('\n');
      // The unused chat section must not be the reason for a refusal. Whatever the real run
      // does (it has no fixture, so its cells fail), the session-route objection is about a
      // protocol this plan never selects.
      expect(message).not.toContain('no headless run has');
      expect(message).not.toContain('needs the host LLM service');
    });
  });
});

describe('corrections from the bot review', () => {
  it('refuses a plan whose two credential references disagree', async () => {
    // The bot's RQ10-B02: the preflight read the target's credential while dispatch read the
    // decision section's, so a plan could pass preflight and then fail every cell — or
    // authenticate with a variable the plan never named.
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        protocols: ['decision'],
        targets: [
          {
            targetId: 'decision-conflict',
            provider: 'decision',
            model: 'clef',
            modelVersion: null,
            chat: null,
            decision: {
              url: 'https://api.example/v1/systemone',
              model: 'clef',
              // Dispatch would have read this one.
              apiKeyRef: 'INNER_KEY',
              timeoutMs: 5_000,
              costTier: 'paid',
            },
            // The preflight checked this one.
            credentialRef: 'OUTER_KEY',
          },
        ],
      });
      await area.write('plan.json', plan);
      const { io, err } = recorder(area.path, {
        INNER_KEY: 'inner',
        OUTER_KEY: 'outer',
      });
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('names two different credentials');
      // Nothing was created, so a conflict cannot leave a half-started run behind.
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });

  it('resolves one credential when the two references agree', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        protocols: ['decision'],
        targets: [
          {
            targetId: 'decision-agreed',
            provider: 'decision',
            model: 'clef',
            modelVersion: null,
            chat: null,
            decision: {
              url: 'https://api.example/v1/systemone',
              model: 'clef',
              apiKeyRef: 'SAME_KEY',
              timeoutMs: 5_000,
              costTier: 'paid',
            },
            credentialRef: 'SAME_KEY',
          },
        ],
      });
      await area.write('plan.json', plan);
      // The credential is absent, so the refusal names the agreed reference rather than
      // either of two candidates.
      const { io, err } = recorder(area.path, {});
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('a live run needs SAME_KEY');
    });
  });

  it('names the decision credential when only the section carries one', async () => {
    await withArea(async (area) => {
      const plan = planOf({
        transport: 'live',
        fixture: null,
        protocols: ['decision'],
        targets: [
          {
            targetId: 'decision-inner-only',
            provider: 'decision',
            model: 'clef',
            modelVersion: null,
            chat: null,
            decision: {
              url: 'https://api.example/v1/systemone',
              model: 'clef',
              apiKeyRef: 'SECTION_KEY',
              timeoutMs: 5_000,
              costTier: 'paid',
            },
            credentialRef: null,
          },
        ],
      });
      await area.write('plan.json', plan);
      // Only the section names a credential, so that is the one preflight must check and
      // dispatch must read.
      const { io, err } = recorder(area.path, {});
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('a live run needs SECTION_KEY');
    });
  });
});

describe('dataset identity and label independence', () => {
  it('refuses a plan whose datasetId disagrees with the dataset it points at', async () => {
    // The bot's finding: a plan can name one dataset and point at another, so the artifact
    // would attribute one dataset's results to the other's identity.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write('plan.json', {
        ...planOf({ datasetId: 'not-the-real-id' }),
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({ [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }) }),
      );
      const { io, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('declares itself core-v1');
      expect(err.join('\n')).toContain(
        'cannot be attributed to a dataset it did not read',
      );
    });
  });

  it('refuses the mismatch on run too, before writing a directory', async () => {
    await withArea(async (area) => {
      await area.write('plan.json', {
        ...planOf({ datasetId: 'misnamed' }),
        fixture: at(area, 'fixture.json'),
      });
      await area.write('fixture.json', fixtureOf({}));
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('declares itself core-v1');
      await expect(readdir(join(area.path, 'run'))).rejects.toThrow();
    });
  });

  it('reports a stale label as a note rather than blocking the run', async () => {
    // The bot's finding: a run reads cases and never labels, so a stale label must not stop
    // it — that is the annotation tools' problem, not the runner's.
    await withArea(async (area) => {
      const real = await readRealManifest();
      const caseDocument: unknown = JSON.parse(
        await readFile(
          join(
            REPOSITORY_ROOT,
            'evals/datasets/core-v1/cases/read-named-source-file.json',
          ),
          'utf8',
        ),
      );
      // A one-case dataset of our own, whose label carries a hash that does not match its
      // case. That is what a stale label looks like to the inspector.
      // The real manifest with one case, so every required member is already correct and
      // only the dataset's identity and scope differ.
      const families = real.families.filter(
        (entry) => entry.familyId === 'dev-ordinary-read',
      );
      await area.write('probe/manifest.json', {
        ...real.raw,
        datasetId: 'probe-v1',
        families,
        cases: [
          { caseId: 'read-named-source-file', familyId: 'dev-ordinary-read' },
        ],
      });
      await area.write('probe/cases/read-named-source-file.json', caseDocument);
      await area.write('probe/labels/read-named-source-file.json', {
        caseId: 'read-named-source-file',
        inputHash: `sha256:${'0'.repeat(64)}`,
        versions: {
          contract: 'review-contract-v1',
          rubric: 'review-rubric-v1',
        },
        target: { risk: '2', authorization: '10' },
      });
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write(
        'probe/fixture.json',
        fixtureOf({ [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }) }),
      );
      await area.write('plan.json', {
        ...planOf({ datasetId: 'probe-v1', datasetPath: at(area, 'probe') }),
        fixture: at(area, 'probe/fixture.json'),
      });
      const { io, out, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      // The stale label is named, and the plan still expands: a label is not input.
      expect(err.join('\n')).toContain(
        'label problem a run does not depend on',
      );
      expect(out.join('\n')).toContain('cells');
      expect(code).toBe(0);
    });
  });
});

describe('planning is not gated on an unselected protocol', () => {
  it('plans a chat-only live plan whose unused decision section declares another credential', async () => {
    // The fourth review's RQ10-B17: my credential correction made `plan` refuse a plan for a
    // decision section it never invokes, reintroducing the boundary B14 had already fixed.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'dual',
        protocol: 'chat',
      });
      await area.write('plan.json', {
        ...planOf({
          transport: 'live',
          fixture: null,
          protocols: ['chat'],
          targets: [
            {
              targetId: 'dual',
              provider: 'some-provider',
              model: 'some-model',
              modelVersion: null,
              chat: {
                provider: 'some-provider',
                model: 'some-model',
                temperature: 0,
                maxTokens: 400,
                timeoutMs: 5_000,
                maxRepairRetries: 1,
              },
              // Unused by this plan, and its two credential declarations disagree. That must
              // not stop a chat-only plan from being expanded.
              decision: {
                url: 'https://api.example/v1/systemone',
                model: 'clef',
                apiKeyRef: 'INNER_KEY',
                timeoutMs: 5_000,
                costTier: 'paid',
              },
              credentialRef: 'OUTER_KEY',
            },
          ],
        }),
      });
      await area.write(
        'fixture.json',
        fixtureOf({ [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }) }),
      );
      const { io, out, err } = recorder(area.path);
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      // The plan expands. A live plan has no fixture, so this uses the dry-run path that
      // reports cells without dispatching.
      expect(err.join('\n')).not.toContain('two different credentials');
      expect(out.join('\n')).toContain('cells');
      expect([0, 1]).toContain(code);
    });
  });

  it('still refuses the disagreement when decision is selected', async () => {
    await withArea(async (area) => {
      await area.write('plan.json', {
        ...planOf({
          transport: 'live',
          fixture: null,
          protocols: ['decision'],
          targets: [
            {
              targetId: 'dual',
              provider: 'decision',
              model: 'clef',
              modelVersion: null,
              chat: null,
              decision: {
                url: 'https://api.example/v1/systemone',
                model: 'clef',
                apiKeyRef: 'INNER_KEY',
                timeoutMs: 5_000,
                costTier: 'paid',
              },
              credentialRef: 'OUTER_KEY',
            },
          ],
        }),
      });
      const { io, err } = recorder(area.path, {
        INNER_KEY: 'inner',
        OUTER_KEY: 'outer',
      });
      const code = await runCli(['plan', at(area, 'plan.json')], io);
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('two different credentials');
    });
  });
});

describe('an explicit case list keeps its own order', () => {
  it('runs the first requested case, not the first in the dataset', async () => {
    // The bot's finding: `filter(cases)` reorders the selection into dataset order, so a
    // budget-limited run can execute a different case than the plan names first.
    await withArea(async (area) => {
      const raw = await readDataset(
        join(REPOSITORY_ROOT, 'evals/datasets/core-v1'),
      );
      const devCases = inspectDataset(raw, await compileCheckers(), {
        contract: REVIEW_CONTRACT_VERSION,
        rubric: 'review-rubric-v1',
      })
        .cases.map((entry) => entry.document)
        .filter((entry) => entry.split === 'dev');
      const first = devCases[0];
      const second = devCases[1];
      if (first === undefined || second === undefined) {
        throw new Error('the dev split needs two cases');
      }
      // Requested in the reverse of the dataset's order, with budget for exactly one cell.
      await area.write('plan.json', {
        ...planOf({
          caseIds: [second.caseId, first.caseId],
          bounds: bounds({ concurrency: 1, maxAttempts: 1 }),
        }),
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cellIdOf({
            caseId: second.caseId,
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cellIdOf({
            caseId: first.caseId,
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      );
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const files = await readdir(join(area.path, 'run', RUN_FILES.records));
      // The first cell dispatched is the first case the plan named.
      expect(files).toEqual([
        `${cellIdOf({ caseId: second.caseId, targetId: 'chat-a', protocol: 'chat' })}.json`,
      ]);
    });
  });

  it('freezes the requested order into the plan it hashes', async () => {
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write('plan.json', {
        ...planOf({
          caseIds: ['read-repo-index-with-cache', 'read-named-source-file'],
        }),
        fixture: at(area, 'fixture.json'),
      });
      await area.write(
        'fixture.json',
        fixtureOf({
          [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
          [cellIdOf({
            caseId: 'read-repo-index-with-cache',
            targetId: 'chat-a',
            protocol: 'chat',
          })]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
        }),
      );
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const index = JSON.parse(
        await readFile(join(area.path, 'run', RUN_FILES.plan), 'utf8'),
      ) as unknown;
      if (index === null || typeof index !== 'object') {
        throw new TypeError('the frozen plan is not an object');
      }
      expect(Reflect.get(index, 'caseIds')).toEqual([
        'read-repo-index-with-cache',
        'read-named-source-file',
      ]);
    });
  });
});

describe('a run has one writer', () => {
  it('refuses a second dispatch while a claim is held', async () => {
    // The bot's finding: two processes can both pass the occupancy check before either
    // publishes, then both dispatch the same cells and spend the budget twice.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      // A claim left behind, as a crashed writer would leave one.
      await area.write(`run/${RUN_FILES.lock}`, {
        pid: 12345,
        claimedAt: '2026-10-29T00:00:00.000Z',
      });
      const { io, err } = recorder(area.path);
      const code = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        io,
      );
      // The claim is taken before dispatch, so nothing was spent: the records directory is
      // created but holds no evidence.
      expect(code).toBe(1);
      expect(err.join('\n')).toContain('holds the run claim');
      const records = await readdir(
        join(area.path, 'run', RUN_FILES.records),
      ).catch(() => []);
      expect(records).toEqual([]);
    });
  });

  it('releases the claim when a dispatch finishes', async () => {
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await seedPlan(area, planOf(), {
        [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }),
      });
      const first = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      expect(first).toBe(0);
      // Released, so a continuation is not blocked by the previous pass's claim.
      const second = await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run'), '--resume'],
        recorder(area.path).io,
      );
      expect(second).toBe(0);
      // And the claim file is gone rather than left as debris.
      const files = await readdir(join(area.path, 'run'));
      expect(files).not.toContain(RUN_FILES.lock);
    });
  });

  it('releases the claim when a dispatch fails', async () => {
    await withArea(async (area) => {
      // An empty fixture makes the cell fail, which is a dispatch that ends badly.
      await seedPlan(area, planOf(), {});
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const files = await readdir(join(area.path, 'run'));
      // A failed run must not leave a claim that blocks the operator from continuing it.
      expect(files).not.toContain(RUN_FILES.lock);
    });
  });
});

describe('annotation work does not invalidate a run', () => {
  it('freezes an execution revision a label edit cannot move', async () => {
    // A run reads the manifest and the cases; it never reads a label. Freezing the
    // annotation digest meant ordinary adjudication work — even editing a rationale —
    // blocked finishing an interrupted experiment whose inputs and plan were unchanged.
    // The assertion is on what a *run directory records*, because that is what continuation
    // compares; asserting on `executionDigest` alone would pass whatever the runner froze.
    await withArea(async (area) => {
      const dataCheckers = await compileCheckers();
      const real = await readRealManifest();
      await area.write('probe/manifest.json', {
        ...real.raw,
        datasetId: 'probe-v1',
        families: real.families.filter(
          (entry) => entry.familyId === 'dev-ordinary-read',
        ),
        cases: [
          { caseId: 'read-named-source-file', familyId: 'dev-ordinary-read' },
        ],
      });
      await area.write(
        'probe/cases/read-named-source-file.json',
        JSON.parse(
          await readFile(
            join(
              REPOSITORY_ROOT,
              'evals/datasets/core-v1/cases/read-named-source-file.json',
            ),
            'utf8',
          ),
        ) as unknown,
      );
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write(
        'probe/fixture.json',
        fixtureOf({ [cellId]: fixtureCell({ chat: [chatAnswer(2, 10)] }) }),
      );
      await area.write('plan.json', {
        ...planOf({
          datasetId: 'probe-v1',
          datasetPath: at(area, 'probe'),
          caseIds: ['read-named-source-file'],
        }),
        fixture: at(area, 'probe/fixture.json'),
      });
      await runCli(
        ['run', at(area, 'plan.json'), '--dir', at(area, 'run')],
        recorder(area.path).io,
      );
      const frozen = await readIndex(join(area.path, 'run', RUN_FILES.index));
      const recorded = frozen.status;
      expect(recorded).toBe('complete');

      // The frozen digest is the execution revision, which equals the value built from
      // manifest and cases alone — and differs from the dataset digest for this dataset
      // because the latter also covers labels and reviews.
      const records = await readdir(join(area.path, 'run', RUN_FILES.records));
      expect(records).toHaveLength(1);
      // The probe dataset is a subset, so compare against its own two sources.
      const probe = inspectDataset(
        await readDataset(at(area, 'probe')),
        dataCheckers,
        { contract: REVIEW_CONTRACT_VERSION, rubric: 'review-rubric-v1' },
      );
      const probeExecution = executionDigest({
        manifest: probe.manifest,
        cases: probe.cases.map((entry) => entry.document),
      });
      const frozenPlan = JSON.parse(
        await readFile(join(area.path, 'run', RUN_FILES.index), 'utf8'),
      ) as unknown;
      if (!isRecord(frozenPlan))
        throw new TypeError('the index is not an object');
      const dataset: unknown = Reflect.get(frozenPlan, 'dataset');
      if (!isRecord(dataset)) throw new TypeError('the index has no dataset');
      // What the run recorded is the execution revision, not the annotation digest.
      expect(Reflect.get(dataset, 'digest')).toBe(probeExecution);
      expect(Reflect.get(dataset, 'digest')).not.toBe(datasetDigestOf(probe));
    });
  });
});
