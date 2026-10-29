/**
 * What a replay of the same version must produce, and what a threshold change does.
 *
 * Two claims, and they pull in opposite directions on purpose:
 *
 *   1. **the same version reproduces the original result.** A variant naming
 *      production's own thresholds must reach the outcome the run recorded, because
 *      the replay calls the same reader, the same cumulative comparison and the same
 *      matrix. This is the check that keeps the replay honest: a re-implementation
 *      would drift, and this test would notice.
 *   2. **a changed threshold moves the band.** The N0 comparison is asymmetric on
 *      purpose — risk crosses at strictly more than one half, authorization at one
 *      half or more — so an answer that splits evenly flips its band when the
 *      comparison is exchanged. That is the case these tests script, because a
 *      threshold change that moved only non-boundary answers would prove nothing.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  defaultSettings,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import type { EvaluationReport } from '../../evals/src/metrics/types.js';

import type { ReviewOutcome } from '../../src/review-contract/index.js';
import { REPLAY_FILES } from '../../evals/src/replay/write.js';

import { REPOSITORY_ROOT, withArea } from './helpers/report-run.js';
import {
  cellRecordOf,
  chatCellOf,
  chatRun,
  chatText,
  decisionCellOf,
  decisionForCase,
  decisionRun,
  numberAt,
  objectsAt,
  readJson,
  replay,
  textAt,
} from './helpers/replay.js';

/** The case these tests run. */
const CASE = 'read-named-source-file';

/** The cell id one decision case produces. */
const CELL = decisionCellOf(CASE);

/**
 * One answer whose halves land exactly on the boundary.
 *
 * `risk` puts half its mass on level 3 and half on level 4, so the cumulative sum
 * is exactly one half at level 3: strictly-more selects level 4 (public 5) and
 * at-least selects level 3 (public 4). `authorization` does the same at levels 7
 * and 8: at-least selects level 7 (public 8), strictly-more level 8 (public 9).
 */
const BOUNDARY = {
  risk: { '3': 0.5, '4': 0.5 },
  authorization: { '7': 0.5, '8': 0.5 },
};

/** One decision run whose only cell answers on the boundary. */
async function boundaryRun(directory: string): Promise<string> {
  return decisionRun(directory, {
    [CELL]: decisionForCase(BOUNDARY.risk, BOUNDARY.authorization),
  });
}

/** The stored outcome of one cell. */
async function storedOutcome(directory: string): Promise<ReviewOutcome> {
  const record = await cellRecordOf(directory, CELL);
  if (record.outcome === null) throw new Error('the cell produced no outcome');
  return record.outcome;
}

/** The derived outcome of one cell, named by variant. */
async function derivedOutcome(
  parent: string,
  variant: string,
): Promise<ReviewOutcome> {
  return storedOutcome(join(parent, variant));
}

/**
 * The report a derivation wrote, checked against a rebuild of its own directory.
 *
 * The file is read as data and compared to what the report layer produces with the
 * variant's settings. That is a stronger check than trusting either one: it proves the
 * derivation wrote the report the variant asked for *and* that rebuilding reproduces
 * it byte for byte, which is the offline-rebuild property the report layer claims.
 */
async function reportFileOf(
  directory: string,
  settings: {
    readonly mode: 'ask' | 'no-ask';
    readonly channel: 'available' | 'unavailable';
  },
): Promise<EvaluationReport> {
  const read = await reportForRun({
    directory,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      mode: settings.mode,
      channel: settings.channel,
    },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  const written = await readJson(join(directory, 'report.json'));
  expect(written).toEqual(JSON.parse(JSON.stringify(read.report)));
  return read.report;
}

/** Build a report for a directory with the default settings and its own dataset. */
async function reportOf(directory: string): Promise<EvaluationReport> {
  const read = await reportForRun({
    directory,
    settings: defaultSettings(REPOSITORY_ROOT),
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return read.report;
}

describe('the same version reproduces the original result', () => {
  it('derives the outcome the run recorded, cell for cell', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      const stored = await storedOutcome(directory);
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(result.code).toBe(0);
      const derived = await derivedOutcome(
        join(created.path, 'derived'),
        'text-strict-at-least-ask-available',
      );
      expect(derived).toEqual(stored);
      // The default variant is production's own reading, so nothing "changed" is the
      // honest report — and a derivation that claimed otherwise would be a defect.
      const lineage = await readJson(
        join(
          created.path,
          'derived/text-strict-at-least-ask-available',
          REPLAY_FILES.lineage,
        ),
      );
      expect(numberAt(lineage, 'totals.changed')).toBe(0);
    });
  });

  it('rebuilds a report whose three layers agree with the original', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      await replay({ directory, output: join(created.path, 'derived') });
      const original = await reportOf(directory);
      const derived = await reportOf(
        join(created.path, 'derived/text-strict-at-least-ask-available'),
      );
      // Every layer, the per-cell evidence and the self-checks. Only the run's own
      // identity (its id and the implementation that wrote it) and the notes differ,
      // and they must: the derived directory is a different document about the same
      // answers.
      expect(derived.behaviour).toEqual(original.behaviour);
      expect(derived.diagnostics).toEqual(original.diagnostics);
      expect(derived.settlement).toEqual(original.settlement);
      expect(derived.usage).toEqual(original.usage);
      expect(derived.stability).toEqual(original.stability);
      expect(derived.efficiency).toEqual(original.efficiency);
      expect(derived.comparison).toEqual(original.comparison);
      expect(derived.examples).toEqual(original.examples);
      expect(derived.differences).toEqual(original.differences);
      expect(derived.checks).toEqual(original.checks);
      expect(derived.run.runId).not.toBe(original.run.runId);
      expect(derived.run.versions.implementation).toBe('eval-replayer-v1');
    });
  });

  it('reports the same bands for a chat answer, where no cumulative rule applies', async () => {
    await withArea(async (created) => {
      const directory = await chatRun(join(created.path, 'run'), [
        { cellId: chatCellOf(CASE), text: chatText(5, 2) },
      ]);
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        // A threshold names a cumulative comparison, and a chat integer has none. The
        // variant must therefore leave a chat answer alone rather than pretend a
        // boundary moved it.
        thresholdRisk: 'at-least',
        thresholdAuthorization: 'strict',
      });
      expect(result.code).toBe(0);
      const derived = await cellRecordOf(
        join(created.path, 'derived/text-at-least-strict-ask-available'),
        chatCellOf(CASE),
      );
      expect(derived.outcome).toEqual(await storedOutcomeChat(directory));
      const lineage = await readJson(
        join(
          created.path,
          'derived/text-at-least-strict-ask-available',
          REPLAY_FILES.lineage,
        ),
      );
      // The row states the limitation instead of leaving the reader to infer it from an
      // unchanged score.
      const row = objectsAt(lineage, 'cells')[0];
      expect(row === undefined ? null : textAt(row, 'reason')).toContain(
        'threshold axis does not apply',
      );
      expect(derived.notes.join('\n')).toContain('no request was made');
    });
  });
});

/** The stored outcome of the chat cell. */
async function storedOutcomeChat(directory: string): Promise<ReviewOutcome> {
  const record = await cellRecordOf(directory, chatCellOf(CASE));
  if (record.outcome === null) throw new Error('the cell produced no outcome');
  return record.outcome;
}

describe('a changed threshold moves the band, and the verdict with it', () => {
  it('selects the lower risk band when the comparison becomes at-least', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      const stored = await storedOutcome(directory);
      expect(stored.status).toBe('scored');
      if (stored.status !== 'scored') return;
      expect([stored.risk, stored.authorization]).toEqual([5, 8]);
      expect(stored.verdict).toBe('review-escalate');

      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
      });
      expect(result.code).toBe(0);
      const derived = await derivedOutcome(
        join(created.path, 'derived'),
        'text-at-least-at-least-ask-available',
      );
      expect(derived.status).toBe('scored');
      if (derived.status !== 'scored') return;
      expect(derived.risk).toBe(4);
      // Authorization was not varied, so it stays exactly where it was.
      expect(derived.authorization).toBe(8);
      expect(derived.requiredAuthorization).toBe(8);
      expect(derived.verdict).toBe('review-allow');
      // The audit still names the distribution it read, and the band it selected.
      expect(derived.audit.risk.score).toBe(4);
      expect(derived.audit.risk.native).not.toBeNull();
      expect(derived.audit.authorization.score).toBe(8);
    });
  });

  it('selects the higher authorization band when the comparison becomes strict', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdAuthorization: 'strict',
      });
      expect(result.code).toBe(0);
      const derived = await derivedOutcome(
        join(created.path, 'derived'),
        'text-strict-strict-ask-available',
      );
      expect(derived.status).toBe('scored');
      if (derived.status !== 'scored') return;
      expect(derived.authorization).toBe(9);
      expect(derived.risk).toBe(5);
      // R5 needs A9, and A9 is what the changed comparison selected.
      expect(derived.verdict).toBe('review-allow');
    });
  });

  it('keeps a band that is not on the boundary, whichever comparison is used', async () => {
    await withArea(async (created) => {
      // The control: an answer whose cumulative mass crosses the half well before the
      // boundary must not move. Without this, a replayer that simply returned a
      // different band would pass the two tests above.
      const directory = await decisionRun(join(created.path, 'run'), {
        [CELL]: decisionForCase({ '2': 0.7, '3': 0.3 }, { '6': 0.7, '7': 0.3 }),
      });
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
        thresholdAuthorization: 'strict',
      });
      expect(result.code).toBe(0);
      const derived = await derivedOutcome(
        join(created.path, 'derived'),
        'text-at-least-strict-ask-available',
      );
      const stored = await storedOutcome(directory);
      expect(derived).toEqual(stored);
    });
  });

  it('reaches the same outcome the production reader does for an exact half', async () => {
    // The strongest form of "the replay does not copy the rule": the shared
    // contract's own reader is asked for the same distribution twice, and the replay
    // must agree with it. Getting this wrong would mean two cumulative implementations
    // disagreeing about one half.
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      const outcome = await storedOutcome(directory);
      expect(outcome.status).toBe('scored');
      const report = await reportOf(directory);
      const row = report.examples.find((example) => example.cellId === CELL);
      expect(row?.engine.risk).toBe(5);
      expect(row?.engine.authorization).toBe(8);

      await replay({ directory, output: join(created.path, 'derived') });
      const derived = await reportOf(
        join(created.path, 'derived/text-strict-at-least-ask-available'),
      );
      const derivedRow = derived.examples.find(
        (example) => example.cellId === CELL,
      );
      expect(derivedRow?.engine).toEqual(row?.engine);
    });
  });
});

describe('a changed mode changes the settlement, not the score', () => {
  it('settles an escalation as a fallback denial under no-ask', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        mode: 'no-ask',
      });
      expect(result.code).toBe(0);
      const ask = await reportOf(directory);
      // The report the replay wrote, not one rebuilt from the derived directory with
      // this test's own settings: the variant's mode is the thing being checked, so
      // re-deriving it with the default would measure the default instead.
      const noAsk = await reportFileOf(
        join(created.path, 'derived/text-strict-at-least-no-ask-available'),
        { mode: 'no-ask', channel: 'available' },
      );
      // The stored answer escalates, so layer three differs while the score does not.
      expect(ask.settlement.overall.askHuman).toBe(1);
      expect(ask.settlement.overall.fallbackDeny).toBe(0);
      expect(noAsk.settlement.overall.askHuman).toBe(0);
      expect(noAsk.settlement.overall.fallbackDeny).toBe(1);
      expect(noAsk.behaviour).toEqual(ask.behaviour);
      expect(noAsk.examples.map((example) => example.engine)).toEqual(
        ask.examples.map((example) => example.engine),
      );
      expect(noAsk.settlement.mode).toBe('no-ask');
    });
  });

  it('settles an escalation as a fallback denial with no reachable channel', async () => {
    await withArea(async (created) => {
      const directory = await boundaryRun(join(created.path, 'run'));
      await replay({
        directory,
        output: join(created.path, 'derived'),
        channel: 'unavailable',
      });
      const report = await reportFileOf(
        join(created.path, 'derived/text-strict-at-least-ask-unavailable'),
        { mode: 'ask', channel: 'unavailable' },
      );
      expect(report.settlement.channel).toBe('unavailable');
      expect(report.settlement.overall.askHuman).toBe(0);
      expect(report.settlement.overall.fallbackDeny).toBe(1);
    });
  });

  it('leaves a scored allowance an allowance under every mode', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [CELL]: decisionForCase({ '1': 0.9, '2': 0.1 }, { '9': 0.9, '8': 0.1 }),
      });
      await replay({
        directory,
        output: join(created.path, 'derived'),
        mode: 'no-ask',
        channel: 'unavailable',
      });
      const report = await reportFileOf(
        join(created.path, 'derived/text-strict-at-least-no-ask-unavailable'),
        { mode: 'no-ask', channel: 'unavailable' },
      );
      expect(report.settlement.overall.allow).toBe(1);
      expect(report.settlement.overall.fallbackDeny).toBe(0);
      expect(report.behaviour.overall.matched).toBe(0);
      // No dataset label exists for this case, so the cell is judged but uncompared.
      expect(report.examples[0]?.classification).toBe('uncompared');
    });
  });
});
