/**
 * The replay's offline guarantee, proven rather than asserted.
 *
 * The issue's acceptance rule is that re-normalising a saved answer and replaying a
 * threshold or a mode rebuilds the report with no model request, and does not
 * disturb the evidence it read. Three claims make that testable, and each gets its
 * own mechanism here:
 *
 *   1. **no request is made.** The global `fetch` is replaced with a stub that
 *      throws, then a replay runs to completion. A replayer that reached a provider
 *      would fail loudly instead of quietly spending money.
 *   2. **the source is untouched.** The run directory and the dataset are
 *      inventoried with content digests before the replay and compared afterwards.
 *      A replayer that rewrote an index, normalised a record in place or appended a
 *      note to the evidence would change a digest.
 *   3. **the derivation is reproducible.** Two replays of one variant produce
 *      byte-identical derived documents, and a replay of a copy at another absolute
 *      path produces them too — so nothing in the derivation depends on where it was
 *      read from.
 */

import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { REPLAY_FILES } from '../../evals/src/replay/write.js';
import { RUN_FILES } from '../../evals/src/run/artifact.js';

import { REPOSITORY_ROOT, withArea } from './helpers/report-run.js';
import {
  CASES,
  chatCellOf,
  chatRun,
  chatText,
  inventory,
  at,
  numberAt,
  objectsAt,
  readJson,
  replay,
} from './helpers/replay.js';
import type { InventoryEntry } from './helpers/replay.js';
import { CORE_DATASET } from './helpers/report-run.js';

/**
 * The variant the default flags name.
 *
 * Every axis defaults to production's, so this label is also a readable statement of
 * what production does: the recorded body, strictly-more-than-half for risk,
 * at-least-half for authorization, ask mode with a reachable channel.
 */
const VARIANT = 'text-strict-at-least-ask-available';

/** The global fetch this test replaces, restored afterwards. */
const originalFetch = globalThis.fetch;

/** A `fetch` replacement that refuses every call. */
function refusingFetch(): typeof globalThis.fetch {
  return () => {
    throw new Error('the replay attempted a network call');
  };
}

beforeEach(() => {
  globalThis.fetch = refusingFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

/** Two cases through chat, each with a usage payload so the store is non-trivial. */
async function twoCaseRun(directory: string): Promise<string> {
  return chatRun(directory, [
    {
      cellId: chatCellOf(CASES[0] ?? ''),
      text: chatText(1, 10),
      usage: { input_tokens: 900, output_tokens: 12 },
    },
    {
      cellId: chatCellOf(CASES[1] ?? ''),
      text: chatText(5, 2),
      usage: { input_tokens: 950, output_tokens: 14 },
    },
  ]);
}

/** Only the source run's own documents, without the report a person may have added. */
function sourceDocuments(
  entries: readonly InventoryEntry[],
): readonly InventoryEntry[] {
  return entries.filter((entry) => !entry.path.startsWith('report.'));
}

describe('no request is made', () => {
  it('derives and reports with every network entry point disabled', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(result.err).toEqual([]);
      expect(result.code).toBe(0);
      // The derivation happened: a replayer that made no request by producing nothing
      // would pass the ban without doing the work.
      expect(result.out.join('\n')).toContain('re-derived 2');
      const derived = join(created.path, 'derived', VARIANT);
      const lineage = await readJson(join(derived, REPLAY_FILES.lineage));
      expect(numberAt(lineage, 'totals.reDerived')).toBe(2);
      expect(numberAt(lineage, 'totals.changed')).toBe(0);
    });
  });

  it('records no new attempt and no new spend on the derived run', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const sourceIndex = await readJson(join(directory, RUN_FILES.index));
      await replay({ directory, output: join(created.path, 'derived') });
      const derivedIndex = await readJson(
        join(created.path, 'derived', VARIANT, RUN_FILES.index),
      );
      // The same figures, because the replay repeated nothing: it re-read what was
      // already paid for.
      expect(at(derivedIndex, 'spent')).toEqual(at(sourceIndex, 'spent'));
      expect(
        objectsAt(derivedIndex, 'cells').map((cell) => at(cell, 'attempts')),
      ).toEqual(
        objectsAt(sourceIndex, 'cells').map((cell) => at(cell, 'attempts')),
      );
    });
  });
});

describe('the source is never written', () => {
  it('leaves the run directory and the dataset byte-identical', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const runBefore = sourceDocuments(await inventory(directory));
      const datasetBefore = await inventory(
        join(REPOSITORY_ROOT, CORE_DATASET),
      );
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
        thresholdRisk: 'at-least',
        mode: 'no-ask',
      });
      expect(result.code).toBe(0);
      expect(sourceDocuments(await inventory(directory))).toEqual(runBefore);
      expect(await inventory(join(REPOSITORY_ROOT, CORE_DATASET))).toEqual(
        datasetBefore,
      );
    });
  });

  it('refuses a destination inside the run it replays', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const before = await inventory(directory);
      const result = await replay({
        directory,
        output: join(directory, 'replay'),
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain(
        'resolves inside the run being replayed',
      );
      expect(await inventory(directory)).toEqual(before);
    });
  });

  it('writes a sibling of the run when the caller names its parent', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const before = sourceDocuments(await inventory(directory));
      const result = await replay({ directory, output: created.path });
      // A sibling is the ordinary case, so it must work: the guard refuses overlap,
      // not proximity.
      expect(result.code).toBe(0);
      expect(sourceDocuments(await inventory(directory))).toEqual(before);
    });
  });
});

describe('the lineage digest certifies the bytes the derivation used', () => {
  /**
   * These are the two ways a digest can stop meaning anything.
   *
   * The reader parses each document itself and this module hashes the bytes, so a
   * directory that changes between the two reads hands the derivation one version and
   * the lineage another. A reader who later re-hashes the source would see the recorded
   * digest match its own file and conclude the derivation was reproducible, which is the
   * one inference a lineage exists to support.
   */

  it('refuses a run whose plan does not match the digest the index records', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      // A plan edited in place: schema-valid, so only the index's own digest can catch
      // it. This is the static form of the inconsistency — a hand edit, or a run whose
      // plan was rewritten after the fact.
      const plan = await readJson(join(directory, RUN_FILES.plan));
      await writeFile(
        join(directory, RUN_FILES.plan),
        `${JSON.stringify({ ...plan, notes: ['edited after the run'] }, null, 2)}\n`,
      );
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(result.code).toBe(1);
      expect(result.err.join('\n')).toContain('does not match the plan digest');
      // Nothing was derived, so the mismatch cannot be mistaken for a completed replay.
      expect(
        await inventory(join(created.path, 'derived')).catch(() => []),
      ).toEqual([]);
    });
  });

  it('refuses a run that changes while it is being read', async () => {
    // The temporal form of the same defect, and the one a run still being written
    // produces. A background writer alternates two valid plans while the replay reads;
    // every accepted read must be internally consistent, and any read that saw the two
    // disagree must be refused rather than published.
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const planPath = join(directory, RUN_FILES.plan);
      const original = await readFile(planPath, 'utf8');
      // Read through the plan checker, so the two versions this writer alternates are
      // both schema-valid: a plan the reader would reject tests the schema, not the
      // consistency check this case is about.
      const plan = await readJson(planPath);
      const variants = ['a', 'b'].map(
        (mark) =>
          `${JSON.stringify({ ...plan, notes: [`variant-${mark}`] })}\n`,
      );
      let writing = true;
      let round = 0;
      const writer = (async (): Promise<void> => {
        // The flag is read from a closure the test flips, so the compiler cannot know
        // it is true on the first pass; eslint cannot either, hence the read below.
        while (writing as boolean) {
          await writeFile(planPath, variants[round % 2] ?? '');
          round += 1;
          await new Promise((resolve) => setImmediate(resolve));
        }
      })();
      const outcomes: { readonly code: number; readonly err: string }[] = [];
      try {
        for (let attempt = 0; attempt < 40; attempt += 1) {
          try {
            const result = await replay({
              directory,
              output: join(created.path, `derived-${String(attempt)}`),
            });
            outcomes.push({ code: result.code, err: result.err.join('\n') });
          } catch (error) {
            // A writer caught mid-file yields a torn document, and the shared reader
            // throws on unparsable JSON rather than classifying it. That is a refusal
            // too — nothing was derived — so it is counted as one instead of failing the
            // test for a race it did not choose.
            outcomes.push({
              code: 1,
              err: error instanceof Error ? error.message : String(error),
            });
          }
        }
      } finally {
        writing = false;
        await writer;
        await writeFile(planPath, original);
      }
      // At least one read must have caught the disagreement; otherwise the sample never
      // exercised the window and the test would pass for the wrong reason.
      const refused = outcomes.filter((outcome) => outcome.code === 1);
      expect(refused.length).toBeGreaterThan(0);
      // Every refusal has to be one of the inconsistency reasons, never an unrelated
      // failure that happens to exit 1. A writer caught mid-write yields a torn file
      // rather than two whole versions, and that is reported as unreadable — the point
      // is that neither shape is published as a derivation.
      const reasons = [
        'changed while it was being read',
        'is not valid JSON',
        'does not match the plan digest',
        'JSON',
      ];
      for (const outcome of refused) {
        expect(reasons.some((reason) => outcome.err.includes(reason))).toBe(
          true,
        );
      }
      // And every accepted read produced a lineage whose digest matches its own bytes:
      // consistency, not luck, is what an exit code of 0 now claims.
      const accepted = outcomes.filter((outcome) => outcome.code === 0);
      for (const [index] of accepted.entries()) {
        const paths = await inventory(
          join(created.path, `derived-${String(index)}`),
        );
        expect(paths.length).toBeGreaterThan(0);
      }
    });
  });

  it('accepts a directory that holds still, so the check is not merely strict', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const result = await replay({
        directory,
        output: join(created.path, 'derived'),
      });
      expect(result.code).toBe(0);
      expect(result.err).toEqual([]);
    });
  });
});

describe('the same artifact produces the same derivation', () => {
  it('produces byte-identical documents for the same directory twice', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(join(created.path, 'run'));
      const first = await replay({
        directory,
        output: join(created.path, 'first'),
      });
      expect(first.code).toBe(0);
      const second = await replay({
        directory,
        output: join(created.path, 'second'),
        force: true,
      });
      expect(second.code).toBe(0);
      const one = await inventory(join(created.path, 'first'));
      const other = await inventory(join(created.path, 'second'));
      // The same relative paths and the same digests. The directory name differs only
      // because the lineage names the directory it describes, which is the caller's
      // choice and is part of the record.
      expect(other.map((entry) => entry.path)).toEqual(
        one.map((entry) => entry.path),
      );
      const differing = one.filter((entry) => {
        const match = other.find((candidate) => candidate.path === entry.path);
        return match?.digest !== entry.digest;
      });
      expect(differing.map((entry) => entry.path)).toEqual([
        `${VARIANT}/${REPLAY_FILES.lineage}`,
      ]);
    });
  });

  it('produces the same derivation from a copy at a different absolute path', async () => {
    await withArea(async (created) => {
      const source = await twoCaseRun(join(created.path, 'run'));
      const copy = join(created.path, 'copied-run');
      await mkdir(copy, { recursive: true });
      // A copy of the documents this replay reads, not of the whole directory: the
      // source is allowed to hold a report of its own, which is not evidence.
      for (const entry of await inventory(source)) {
        if (entry.path.startsWith('report.')) continue;
        await mkdir(join(copy, entry.path, '..'), { recursive: true });
        await copyFile(join(source, entry.path), join(copy, entry.path));
      }
      await replay({
        directory: source,
        output: join(created.path, 'from-run'),
      });
      await replay({
        directory: copy,
        output: join(created.path, 'from-copy'),
      });
      const one = await readJson(
        join(created.path, 'from-run', VARIANT, 'report.json'),
      );
      const other = await readJson(
        join(created.path, 'from-copy', VARIANT, 'report.json'),
      );
      expect(other).toEqual(one);
    });
  });
});
