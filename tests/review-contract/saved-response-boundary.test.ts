/**
 * The sum-tolerance fix, checked against responses a real provider actually sent.
 *
 * The S1 pilot's largest finding was that five of six local-Clef failures were one
 * float ulp wide: the answers' *decimal* totals sat exactly on `SUM_TOLERANCE` and the
 * float comparison pushed them outside. A unit test built from hand-picked numbers
 * would prove the arithmetic; it would not prove the fix reaches the answers the
 * provider really produced.
 *
 * So the inputs here are captured responses, copied verbatim from the Clef capture
 * files named in each entry of `tests/fixtures/saved-clef-distributions.json`. The
 * test asserts three things for every capture: what the old float rule decided, what
 * the fixed rule decides, and that the corrected decision is the one the decimal total
 * justifies. Keeping the old verdict as an expectation rather than prose is what lets
 * a reader see the repair without re-running the pilot.
 *
 * Nothing here sends a request or re-derives a score. These are the stored bytes, fed
 * to the production reader.
 */

import { readFile } from 'node:fs/promises';

import { describe, expect, it } from 'vitest';

import {
  addDecimals,
  bandFromNative,
  exactDecimal,
  readProtocolScores,
  SUM_TOLERANCE,
  validateNativeDistribution,
} from '../../src/review-contract/index.js';

interface SavedCapture {
  readonly id: string;
  readonly capture: string;
  readonly capturePointer: string;
  readonly requestId?: string;
  readonly probabilities: Record<string, number>;
}

interface SavedDistributions {
  readonly schemaVersion: number;
  readonly source: string;
  readonly captures: readonly SavedCapture[];
}

const FIXTURE = new URL(
  '../fixtures/saved-clef-distributions.json',
  import.meta.url,
);

/** The saved captures, read once. */
const saved = async (): Promise<SavedDistributions> =>
  parseDistributions(JSON.parse(await readFile(FIXTURE, 'utf8')));

/** One capture's probabilities, narrowed rather than asserted. */
function probabilitiesOf(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, mass] of Object.entries(value)) {
    if (typeof mass !== 'number') return null;
    out[key] = mass;
  }
  return out;
}

/** The fixture document, narrowed member by member instead of asserted. */
function parseDistributions(parsed: unknown): SavedDistributions {
  if (!isRecord(parsed)) throw new TypeError('the fixture is not an object');
  const schemaVersion = Reflect.get(parsed, 'schemaVersion');
  const source = Reflect.get(parsed, 'source');
  const rows = Reflect.get(parsed, 'captures');
  if (typeof schemaVersion !== 'number' || typeof source !== 'string') {
    throw new TypeError('the fixture has no version or source');
  }
  if (!Array.isArray(rows)) throw new TypeError('captures is not an array');
  const captures: SavedCapture[] = [];
  for (const row of rows as readonly unknown[]) {
    if (!isRecord(row)) throw new TypeError('a capture is not an object');
    const id = Reflect.get(row, 'id');
    const capture = Reflect.get(row, 'capture');
    const capturePointer = Reflect.get(row, 'capturePointer');
    const requestId = Reflect.get(row, 'requestId');
    const probabilities = probabilitiesOf(Reflect.get(row, 'probabilities'));
    if (
      typeof id !== 'string' ||
      typeof capture !== 'string' ||
      typeof capturePointer !== 'string' ||
      probabilities === null
    ) {
      throw new TypeError('a capture is missing a required member');
    }
    captures.push({
      id,
      capture,
      capturePointer,
      ...(typeof requestId === 'string' ? { requestId } : {}),
      probabilities,
    });
  }
  return { schemaVersion, source, captures };
}

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The old rule, kept so the comparison can be asserted rather than remembered. */
function oldFloatVerdict(probabilities: Record<string, number>): boolean {
  const total = Object.values(probabilities).reduce((sum, p) => sum + p, 0);
  return Math.abs(total - 1) > SUM_TOLERANCE;
}

/** The exact decimal total of a distribution, in the contract's own arithmetic. */
function exactTotal(probabilities: Record<string, number>): string {
  return addDecimals(
    Object.values(probabilities)
      .filter((p) => p !== 0)
      .map((p) => {
        const exact = exactDecimal(p);
        if (exact === null) throw new Error('saved value has no exact decimal');
        return exact;
      }),
  );
}

describe('saved Clef responses at the sum-tolerance boundary', () => {
  it('captures the distributions as the provider sent them', async () => {
    const document = await saved();
    expect(document.schemaVersion).toBe(1);
    expect(document.captures.length).toBeGreaterThanOrEqual(5);
    for (const capture of document.captures) {
      // A saved answer is ten canonical levels; anything else would be a broken
      // fixture rather than evidence.
      expect(Object.keys(capture.probabilities).sort()).toEqual([
        '0',
        '1',
        '2',
        '3',
        '4',
        '5',
        '6',
        '7',
        '8',
        '9',
      ]);
    }
  });

  it('one capture is rejected by the old float rule and accepted by the fixed one', async () => {
    const document = await saved();
    const byId = new Map(document.captures.map((c) => [c.id, c]));
    const boundary = byId.get('clef-flash-4bit');
    if (boundary === undefined)
      throw new Error('expected the boundary capture');

    // The decimal total is exactly 0.9999, i.e. exactly SUM_TOLERANCE from one.
    expect(exactTotal(boundary.probabilities)).toBe('0.9999');
    // Float accumulation overshoots by one ulp, which is what the old rule read.
    expect(oldFloatVerdict(boundary.probabilities)).toBe(true);
    // The fixed rule reads the decimal and accepts it.
    expect(validateNativeDistribution(boundary.probabilities).ok).toBe(true);
  });

  it('measures every capture under both rules and states the residue', async () => {
    const document = await saved();
    const rows = document.captures.map((capture) => {
      const total = exactTotal(capture.probabilities);
      const oldRejected = oldFloatVerdict(capture.probabilities);
      const fixedAccepts = validateNativeDistribution(capture.probabilities).ok;
      return { id: capture.id, total, oldRejected, fixedAccepts };
    });
    // Exactly one capture changes verdict, and it changes from rejected to
    // accepted: the fix is a one-answer repair, not a general loosening.
    const repaired = rows.filter((row) => row.oldRejected && row.fixedAccepts);
    expect(repaired).toHaveLength(1);
    expect(repaired[0]?.id).toBe('clef-flash-4bit');
    // Nothing moves the other way: no answer the old rule accepted is now refused.
    expect(rows.filter((row) => !row.oldRejected && !row.fixedAccepts)).toEqual(
      [],
    );
  });

  it('a genuine over-total still fails, so the fix does not widen the bound', async () => {
    // The pilot's sixth failure at 1.0002 is outside by the decimal reading too. This
    // is reconstructed from a saved capture by moving one level past the bound rather
    // than copied, because the failing body was never captured; the numbers around it
    // are the saved ones, so only the total differs.
    const document = await saved();
    const base = document.captures.find((c) => c.id === 'clef-flash-4bit');
    if (base === undefined) throw new Error('expected the boundary capture');
    const outside = {
      ...base.probabilities,
      '9': 0.0619,
    };
    expect(exactTotal(outside)).toBe('1.0001');
    // On the bound, so accepted.
    expect(validateNativeDistribution(outside).ok).toBe(true);
    const beyond = { ...base.probabilities, '9': 0.062 };
    expect(exactTotal(beyond)).toBe('1.0002');
    const result = validateNativeDistribution(beyond);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a rejection');
    expect(result.reason).toBe('probability-sum-not-one');
  });

  it('an accepted saved capture scores through the production reader', async () => {
    // The repair has to reach the score, not just the validator: the boundary answer
    // is read as a distribution and N0 picks its band.
    const document = await saved();
    const boundary = document.captures.find((c) => c.id === 'clef-flash-4bit');
    if (boundary === undefined)
      throw new Error('expected the boundary capture');
    const read = readProtocolScores({
      source: 'decision',
      risk: boundary.probabilities,
      // A complete ten-level distribution, because the contract rejects a sparse one:
      // nine unreported levels would have invented a total.
      authorization: {
        '0': 0,
        '1': 0,
        '2': 0,
        '3': 0,
        '4': 0,
        '5': 0,
        '6': 0,
        '7': 0,
        '8': 0,
        '9': 1,
      },
    });
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error('expected a scored answer');
    // The saved answer's cumulative mass crosses one half inside level 3, so the
    // formal band is public 5 and the distribution is kept for the audit.
    expect(read.risk).toBe(bandFromNative(boundary.probabilities, 'risk'));
    expect(read.risk).toBe(5);
    expect(read.audit.risk.native).toEqual(boundary.probabilities);
  });
});
