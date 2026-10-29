/**
 * The formatting primitives every renderer shares.
 *
 * Three rules are centralised here because a renderer that restated them would drift
 * from the document it is printing:
 *
 *   - a null rate prints as `n/a`, never `0%`. The report's own contract says a rate
 *     over no denominator is unknown, and a renderer that printed `0.0%` would silently
 *     retract that.
 *   - a fraction always shows its denominator beside the percentage, so a reader cannot
 *     read a rate without knowing what it was measured over.
 *   - a nullable count prints as 未知 rather than as zero, for the same reason the
 *     artifact keeps them distinct.
 */

/** A rate as a percentage, or `n/a` when nothing was measurable. */
export function pct(value: number | null): string {
  return value === null ? 'n/a' : `${(value * 100).toFixed(1)}%`;
}

/** A nullable number, printed as the unknown it is. */
export function num(value: number | null): string {
  return value === null ? '未知' : String(value);
}

/** A fraction as `part/whole`, so a reader always sees the denominator. */
export function fraction(part: number, whole: number): string {
  return `${String(part)}/${String(whole)}`;
}

/** A rate with its denominator, which is the only form this report prints one in. */
export function rateText(part: number, whole: number): string {
  return `${pct(whole === 0 ? null : part / whole)} (${fraction(part, whole)})`;
}

/** A cell value escaped for a Markdown table. */
export function cellOf(value: string): string {
  return value.replaceAll('|', '\\|').replaceAll('\n', ' ');
}

/** One row of a table, as a Markdown line. */
export function row(values: readonly string[]): string {
  return `| ${values.map(cellOf).join(' | ')} |`;
}

/** A table's separator line, given its column count. */
export function separator(columns: number): string {
  return `| ${Array.from({ length: columns }, () => '---').join(' | ')} |`;
}

/** A heading, at a level the nesting below expects. */
export function heading(level: number, text: string): string {
  return `${'#'.repeat(level)} ${text}`;
}

/** A bulleted list, or nothing at all when the list is empty. */
export function bullets(items: readonly string[]): string {
  return items.length === 0 ? '' : items.map((item) => `- ${item}`).join('\n');
}
