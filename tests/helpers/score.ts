/**
 * A checked score helper for tests.
 *
 * The public scale is a union of ten literals, so a test that passes a plain
 * number would need an assertion. Asserting in a test is banned here (and is the
 * wrong shape anyway): the helper validates through the contract's own guard, so a
 * typo in a test fails loudly instead of narrowing silently.
 */

import {
  isNativeLevel,
  isPublicScore,
} from '../../src/review-contract/rubrics.js';
import type {
  NativeLevel,
  PublicScore,
} from '../../src/review-contract/types.js';

/** A public score from a number the caller believes is legal. */
export function score(value: number): PublicScore {
  if (!isPublicScore(value)) {
    throw new RangeError(`${String(value)} is not a public score`);
  }
  return value;
}

/** A native level from a number the caller believes is legal. */
export function native(value: number): NativeLevel {
  if (!isNativeLevel(value)) {
    throw new RangeError(`${String(value)} is not a native level`);
  }
  return value;
}

/**
 * Legal values only: the range-refusal tests are written against the two extremes
 * of each legal range, and the illegal side is exercised on the raw helpers above,
 * which reject rather than narrow.
 */

/** A row of verdict letters, so a spread is over code units, not characters. */
export function letters(row: string): readonly string[] {
  return Array.from(row);
}
