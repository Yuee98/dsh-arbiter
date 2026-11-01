/** Map decoded JSON string spans back to raw text without treating channels as a stream. */
export interface CredentialSpan {
  readonly start: number;
  readonly end: number;
  readonly marker: string;
}
interface KnownValue {
  readonly value: string;
  readonly marker: string;
}
export function structuredJson(text: string): boolean {
  const first = text.trimStart()[0];
  if (first !== '{' && first !== '[') return false;
  try {
    return JSON.parse(text) !== null;
  } catch {
    return false;
  }
}
export function quotedCredentialSpans(
  text: string,
  secrets: Iterable<KnownValue>,
  limit: number,
): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  const known = [...secrets];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"/gu)) {
    let decoded: unknown;
    try {
      decoded = JSON.parse(match[0]);
    } catch {
      continue;
    }
    if (typeof decoded !== 'string') continue;
    const found: CredentialSpan[] = [];
    for (const secret of known) {
      let at = decoded.indexOf(secret.value);
      while (at >= 0) {
        if (spans.length + found.length >= limit)
          throw new Error('credential text span limit exceeded');
        found.push({
          start: at,
          end: at + secret.value.length,
          marker: secret.marker,
        });
        at = decoded.indexOf(secret.value, at + secret.value.length);
      }
    }
    if (found.length === 0) continue;
    const points = new Set(found.flatMap((span) => [span.start, span.end]));
    const raw = new Map<number, number>();
    let logical = 0;
    for (let index = 1; index < match[0].length; logical += 1) {
      if (points.has(logical)) raw.set(logical, index + match.index);
      index +=
        match[0][index] === '\\' ? (match[0][index + 1] === 'u' ? 6 : 2) : 1;
    }
    for (const span of found) {
      const start = raw.get(span.start);
      const end = raw.get(span.end);
      if (start === undefined || end === undefined)
        throw new Error('credential quoted span could not be safely processed');
      spans.push({ ...span, start, end });
    }
  }
  return spans;
}

/** Keep source indices while replacing each span once, at its first block. */
export function applyCredentialSpans(
  blocks: readonly string[],
  ranges: CredentialSpan[],
): readonly string[] {
  ranges.sort((a, b) => a.start - b.start || b.end - a.end);
  const output: string[] = [];
  let offset = 0;
  for (const block of blocks) {
    let cursor = 0;
    let text = '';
    for (const range of ranges) {
      if (
        range.end <= offset ||
        range.start >= offset + block.length ||
        range.end <= offset + cursor
      )
        continue;
      const start = Math.max(cursor, range.start - offset);
      text +=
        block.slice(cursor, start) +
        (range.start >= offset ? range.marker : '');
      cursor = Math.min(block.length, range.end - offset);
    }
    output.push(text + block.slice(cursor));
    offset += block.length;
  }
  return output;
}
