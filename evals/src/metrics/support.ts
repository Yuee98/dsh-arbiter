/**
 * Small numeric and ordering helpers shared by the report's metric modules.
 *
 * Two rules are enforced here rather than repeated at every call site:
 *
 *   - a rate over an empty denominator is `null`, never `0`. A measured zero and
 *     an unmeasurable population are different facts, and a report that prints
 *     `0%` for both invites a reader to conclude something was measured.
 *   - every ordering is by code point. `localeCompare` would make the document
 *     depend on the machine's collation, so two readers of the same artifact
 *     could produce different tables and a rebuild would not be byte-identical.
 */

/** Compare two strings by code point, so the order does not depend on a locale. */
export function compareText(left: string, right: string): number {
  if (left < right) return -1;
  return left > right ? 1 : 0;
}

/** One fraction, or null when nothing could be measured. */
export function ratio(part: number, whole: number): number | null {
  return whole === 0 ? null : part / whole;
}

/** The arithmetic mean, or null for an empty list. */
export function mean(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  let total = 0;
  for (const value of values) total += value;
  return total / values.length;
}

/**
 * The median of a list, or null for an empty list.
 *
 * An even-length list averages its two middle values rather than picking one, so a
 * median over two samples is not silently one of them.
 */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[middle] ?? null;
  const left = sorted[middle - 1] ?? null;
  const right = sorted[middle] ?? null;
  return left === null || right === null ? null : (left + right) / 2;
}

/**
 * The mean of a list, rounded for publication, or null when nothing was reported.
 *
 * The same rounding the rates get: a figure in a report is a summary, and a value with
 * sixteen significant digits invites a reader to treat float noise as precision.
 */
export function meanRounded(values: readonly number[]): number | null {
  const value = mean(values);
  return value === null ? null : fixed(value);
}

/** The largest value, or null for an empty list. */
export function maxOf(values: readonly number[]): number | null {
  let best: number | null = null;
  for (const value of values) {
    if (best === null || value > best) best = value;
  }
  return best;
}

/**
 * A fixed-precision number for the JSON document.
 *
 * Rates are stored rounded so a report rebuilt from the same artifact compares
 * equal rather than differing in the last bit of a float division. The rounding is
 * generous enough that no decision in the report depends on it.
 */
export function fixed(value: number, digits = 6): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

/** A rate, rounded, or null. */
export function rate(part: number, whole: number): number | null {
  const value = ratio(part, whole);
  return value === null ? null : fixed(value);
}

/** Group a list by a key, preserving first-seen order of the keys. */
export function groupBy<T>(
  items: readonly T[],
  keyOf: (item: T) => string,
): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const existing = groups.get(key);
    if (existing === undefined) groups.set(key, [item]);
    else existing.push(item);
  }
  return groups;
}

/** The distinct values of a list, sorted by code point. */
export function distinct(
  values: readonly string[],
  compare: (left: string, right: string) => number = compareText,
): readonly string[] {
  return [...new Set(values)].sort(compare);
}

/** Count occurrences of each key, with the keys sorted. */
export function tally(
  values: readonly string[],
): Readonly<Record<string, number>> {
  const counts: Record<string, number> = {};
  for (const value of values) counts[value] = (counts[value] ?? 0) + 1;
  const sorted: Record<string, number> = {};
  for (const key of Object.keys(counts).sort(compareText)) {
    sorted[key] = counts[key] ?? 0;
  }
  return sorted;
}

/** Sum a list of nullable numbers, keeping "nothing reported" distinct from zero. */
export function sumReported(values: readonly (number | null)[]): number | null {
  let total: number | null = null;
  for (const value of values) {
    if (value === null) continue;
    total = (total ?? 0) + value;
  }
  return total;
}
