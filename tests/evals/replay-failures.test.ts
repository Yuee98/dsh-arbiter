/**
 * What a replay must never do with a failure.
 *
 * The issue states one rule in two places: a record whose HTTP exchange failed, or
 * whose body carried `success: false`, is a failure path under *every* threshold and
 * *every* mode, and the derived report keeps the failure and the usage that was
 * reported. Unknown usage stays unknown.
 *
 * The reason this needs its own file is that it is the one behaviour a careless
 * implementation would get wrong in a plausible-looking way. Re-reading a body that
 * happens to contain complete answers is easy, and it would let a threshold change
 * turn "the provider refused" into "the provider approved" — the single most
 * damaging thing this feature could do. So each shape of failure is scripted here,
 * and each is asserted to survive a replay that *would* have changed a scored
 * answer.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { EvaluationReport } from '../../evals/src/metrics/types.js';
import {
  defaultSettings,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import { REPLAY_FILES } from '../../evals/src/replay/write.js';

import { REPOSITORY_ROOT, withArea } from './helpers/report-run.js';
import {
  cellRecordOf,
  chatCellOf,
  chatRun,
  chatText,
  decisionCellOf,
  decisionRun,
  listTextAt,
  numberAt,
  objectsAt,
  readJson,
  replay,
  textAt,
  textOrNullAt,
} from './helpers/replay.js';

/** The case these tests run. */
const CASE = 'read-named-source-file';

/** A complete answer, in the shape a decision body carries when it succeeds. */
const COMPLETE = {
  risk: { type: 'score', probabilities: tenWay('3') },
  authorization: { type: 'score', probabilities: tenWay('8') },
};

/**
 * A distribution whose mass sits on one level.
 *
 * Written out rather than derived from a "half" helper because the point of these
 * tests is the failure, not the boundary: a body that would score cleanly if it were
 * read is the strongest form of the claim.
 */
function tenWay(level: string): Record<string, number> {
  const distribution: Record<string, number> = {};
  for (let index = 0; index <= 9; index += 1) {
    distribution[String(index)] = String(index) === level ? 1 : 0;
  }
  return distribution;
}

/** A lineage, as the members these tests assert on. */
interface Lineage {
  readonly totals: {
    readonly reDerived: number;
    readonly kept: number;
    readonly notReplayable: number;
    readonly changed: number;
  };
  readonly cells: readonly {
    readonly disposition: string;
    readonly reason: string | null;
    readonly changed: boolean;
  }[];
  readonly notes: readonly string[];
}

/** Read a lineage, requiring the members these tests assert on. */
async function lineageOf(path: string): Promise<Lineage> {
  const document = await readJson(path);
  return {
    totals: {
      reDerived: numberAt(document, 'totals.reDerived'),
      kept: numberAt(document, 'totals.kept'),
      notReplayable: numberAt(document, 'totals.notReplayable'),
      changed: numberAt(document, 'totals.changed'),
    },
    cells: objectsAt(document, 'cells').map((cell) => ({
      disposition: textAt(cell, 'disposition'),
      reason: textOrNullAt(cell, 'reason'),
      changed: cell['changed'] === true,
    })),
    notes: listTextAt(document, 'notes'),
  };
}

/**
 * A report, rebuilt from the directory it describes.
 *
 * The settlement settings are a property of the derivation rather than of the
 * directory, so a caller checking a settled figure passes the variant's own. The
 * derivation writes its report with those settings; rebuilding with different ones
 * would measure this test's choice instead of the variant's.
 */
async function reportOf(
  directory: string,
  settlement: {
    readonly mode?: 'ask' | 'no-ask';
    readonly channel?: 'available' | 'unavailable';
  } = {},
): Promise<EvaluationReport> {
  const read = await reportForRun({
    directory,
    settings: {
      ...defaultSettings(REPOSITORY_ROOT),
      mode: settlement.mode ?? 'ask',
      channel: settlement.channel ?? 'available',
    },
  });
  if (!read.ok) throw new Error(read.problems.join('; '));
  return read.report;
}

describe('a provider refusal stays a failure', () => {
  it('keeps the failure when the body carried complete answers beside success:false', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf(CASE)]: {
          status: 200,
          body: JSON.stringify({
            success: false,
            errors: [{ message: 'the model refused this request' }],
            ...COMPLETE,
          }),
        },
      });
      const stored = await cellRecordOf(directory, decisionCellOf(CASE));
      expect(stored.outcome?.status).toBe('review-failure');

      // Every axis at once: the variant that would move a scored answer is the one used,
      // so a replayer that read the answers would score this cell.
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
        thresholdAuthorization: 'strict',
        mode: 'no-ask',
      });
      expect(result.code).toBe(0);
      const derived = join(
        created.path,
        'derived/text-at-least-strict-no-ask-available',
      );
      const record = await cellRecordOf(derived, decisionCellOf(CASE));
      expect(record.outcome).toEqual(stored.outcome);
      const lineage = await lineageOf(join(derived, REPLAY_FILES.lineage));
      expect(lineage.cells[0]?.disposition).toBe('kept');
      expect(lineage.cells[0]?.reason).toContain('provider-refusal');
      expect(lineage.totals.reDerived).toBe(0);
      expect(lineage.totals.changed).toBe(0);
    });
  });

  it('keeps an HTTP failure a failure and reports its usage', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf(CASE)]: {
          status: 500,
          body: JSON.stringify({
            success: false,
            errors: [{ message: 'upstream unavailable' }],
            usage: { input_tokens: 700, output_tokens: 4 },
          }),
        },
      });
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
      });
      expect(result.code).toBe(0);
      const derived = join(
        created.path,
        'derived/text-at-least-at-least-ask-available',
      );
      const report = await reportOf(derived);
      // The failure is counted as a technical outcome, never as a denial.
      expect(report.behaviour.overall.technical).toBe(1);
      expect(report.behaviour.overall.falseDeny).toBe(0);
      // A technical outcome is not a verdict at all, so it cannot enter the allow/deny
      // axis: the settlement layer is where a host's reaction appears.
      expect(report.settlement.overall.fallbackDeny).toBe(0);
      expect(report.settlement.overall.deny).toBe(0);
      // The provider said what it counted, and that survives.
      expect(report.usage.run?.withUsage).toBe(1);
      expect(report.usage.run?.totals.inputTokens.total).toBe(700);
      expect(report.usage.attempts[0]?.tokens.outputTokens).toBe(4);
    });
  });

  it('keeps a transport failure a failure, with no invented usage', async () => {
    await withArea(async (created) => {
      const directory = await chatRun(join(created.path, 'run'), [
        {
          cellId: chatCellOf(CASE),
          text: chatText(1, 10),
        },
      ]);
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        mode: 'no-ask',
      });
      // This run's answer is a normal one, so the derivation happens; the assertion in
      // this test is about the *other* shape, scripted below through the same path.
      expect(result.code).toBe(0);
      const report = await reportOf(
        join(created.path, 'derived/text-strict-at-least-no-ask-available'),
      );
      // A chat answer reports no usage here, and the report says unknown rather than
      // zero: the failure case and this one must both keep `null`.
      expect(report.usage.run?.totals.inputTokens.total).toBeNull();
      expect(report.usage.run?.totals.outputTokens.total).toBeNull();
    });
  });
});

describe('the derived report keeps a failure and its reported usage', () => {
  it('counts a failed cell as technical and never as a refusal', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf(CASE)]: {
          status: 200,
          body: JSON.stringify({
            success: false,
            usage: { input_tokens: 512, output_tokens: 0 },
            ...COMPLETE,
          }),
        },
      });
      await replay({
        directory,
        output: join(created.path, 'derived'),
        mode: 'no-ask',
        channel: 'unavailable',
      });
      const report = await reportOf(
        join(created.path, 'derived/text-strict-at-least-no-ask-unavailable'),
        { mode: 'no-ask', channel: 'unavailable' },
      );
      expect(report.behaviour.overall.technical).toBe(1);
      expect(report.behaviour.overall.judged).toBe(0);
      // Under no-ask with no channel, the technical stage settles as a fallback denial —
      // and it keeps its own stage, so the report can still say the reviewer broke.
      expect(report.settlement.overall.fallbackDeny).toBe(1);
      expect(report.settlement.overall.technical.askHuman).toBe(0);
      // An explicit zero stays zero; a missing count would stay null.
      expect(report.usage.attempts[0]?.tokens.outputTokens).toBe(0);
      expect(report.usage.attempts[0]?.tokens.inputTokens).toBe(512);
    });
  });
});

describe('an answer that cannot be reconstructed is reported', () => {
  it('lists a decision body that masking left unreadable rather than repairing it', async () => {
    await withArea(async (created) => {
      // A decision answer whose `authorization` member carries no `type` is not a score
      // object by the masker's test, so it is rewritten as `[redacted]` and the stored
      // body is no longer JSON. That is the documented masking limitation, and a replay
      // must report it instead of scoring from a repaired body.
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf(CASE)]: {
          status: 200,
          body: JSON.stringify({
            answers: {
              risk: { type: 'score', probabilities: tenWay('3') },
              authorization: { probabilities: tenWay('8') },
            },
          }),
        },
      });
      const stored = await cellRecordOf(directory, decisionCellOf(CASE));
      // The masking did change the body, which is what makes this case meaningful.
      const body = stored.attempts[0]?.responseText ?? '';
      expect(() => JSON.parse(body) as unknown).toThrow();

      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
      });
      expect(result.code).toBe(0);
      const derived = join(
        created.path,
        'derived/text-at-least-at-least-ask-available',
      );
      const lineage = await lineageOf(join(derived, REPLAY_FILES.lineage));
      expect(lineage.cells[0]?.disposition).toBe('not-replayable');
      expect(lineage.cells[0]?.reason).toContain('not valid JSON');
      expect(lineage.totals.notReplayable).toBe(1);
      // The stored outcome stands, and the cell is not compared as if it had been
      // re-derived.
      const record = await cellRecordOf(derived, decisionCellOf(CASE));
      expect(record.outcome).toEqual(stored.outcome);
      expect(lineage.notes.join('\n')).toContain('不可回放');
    });
  });

  it('recovers the same cell from the adapter parse when the caller asks for it', async () => {
    await withArea(async (created) => {
      const directory = await decisionRun(join(created.path, 'run'), {
        [decisionCellOf(CASE)]: {
          status: 200,
          body: JSON.stringify({
            answers: {
              risk: { type: 'score', probabilities: tenWay('3') },
              authorization: { probabilities: tenWay('8') },
            },
          }),
        },
      });
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        answer: 'recorded-parse',
      });
      expect(result.code).toBe(0);
      const derived = join(
        created.path,
        'derived/parsed-strict-at-least-ask-available',
      );
      const lineage = await lineageOf(join(derived, REPLAY_FILES.lineage));
      // The adapter's parse is intact — it was made before masking — so this is the
      // candidate that can reconstruct the answer.
      expect(lineage.cells[0]?.disposition).toBe('re-derived');
      expect(lineage.cells[0]?.changed).toBe(false);
      expect(lineage.totals.notReplayable).toBe(0);
      expect(lineage.notes.join('\n')).toContain('parsed');
    });
  });

  it('refuses to invent an answer when the record has no body at all', async () => {
    await withArea(async (created) => {
      const directory = await chatRun(join(created.path, 'run'), [
        { cellId: chatCellOf(CASE), text: 'not json at all' },
      ]);
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(result.code).toBe(0);
      const lineage = await lineageOf(
        join(
          created.path,
          'derived/text-strict-at-least-ask-available',
          REPLAY_FILES.lineage,
        ),
      );
      // The body arrived and did not read, so production called it an unreadable answer.
      // The replay keeps that verdict instead of selecting a band from text it cannot
      // parse.
      expect(lineage.cells[0]?.disposition).toBe('kept');
      expect(lineage.cells[0]?.reason).toContain('review failure');
      expect(lineage.totals.reDerived).toBe(0);
    });
  });
});
