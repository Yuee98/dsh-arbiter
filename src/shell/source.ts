/**
 * Source-accounting check for the shell adapter.
 *
 * The candidate parser recovers from malformed input instead of throwing, and
 * not every recovery is reported as an error: `echo (` yields a clean-looking
 * command with the `(` simply missing. Treating "no errors" as "fully parsed"
 * would let a rule cover a call whose real structure is unknown, so the adapter
 * compares the source covered by parsed nodes against the source that carries
 * syntax and reports anything left over.
 *
 * Statement separators, comments, and whitespace legitimately sit between nodes
 * and are not syntax this check needs to account for. Parentheses, braces and
 * redirect operators are NOT stripped: when one of those is left over it is a
 * construct the adapter failed to read.
 */

interface Range {
  readonly start: number;
  readonly end: number;
}

function mergeRanges(ranges: readonly Range[]): Range[] {
  const sorted = ranges
    .filter((range) => range.end >= range.start)
    .sort((left, right) => left.start - right.start || left.end - right.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last !== undefined && range.start <= last.end) {
      if (range.end > last.end)
        merged[merged.length - 1] = { ...last, end: range.end };
      continue;
    }
    merged.push(range);
  }
  return merged;
}

/** A comment begins at start of input or after whitespace, as in POSIX shell. */
function stripComments(text: string): string {
  return text.replace(/(^|\s)#[^\n]*/gu, '$1');
}

/** Only the separators that sit between statements carry no syntax. */
function stripSeparators(text: string): string {
  return text.replace(/\\\n/gu, '').replace(/[;&|\s]+/gu, '');
}

/**
 * The parts of `source` that carry syntax but lie outside every parsed node.
 *
 * Each returned string is the original (trimmed) gap, so a caller can report the
 * exact text that was not understood.
 */
export function unconsumed(
  source: string,
  covered: readonly Range[],
): { readonly text: string; readonly pos: number }[] {
  const ranges = mergeRanges(covered);
  const gaps: { text: string; pos: number }[] = [];
  let cursor = 0;
  for (const range of ranges) {
    if (range.start > cursor) {
      gaps.push({ text: source.slice(cursor, range.start), pos: cursor });
    }
    cursor = Math.max(cursor, range.end);
  }
  if (cursor < source.length) {
    gaps.push({ text: source.slice(cursor), pos: cursor });
  }
  const unparsed: { text: string; pos: number }[] = [];
  for (const gap of gaps) {
    const text = gap.text;
    if (stripSeparators(stripComments(text)).length === 0) continue;
    const leading = text.length - text.trimStart().length;
    unparsed.push({ text: text.trim(), pos: gap.pos + leading });
  }
  return unparsed;
}
