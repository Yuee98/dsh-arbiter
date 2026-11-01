import type { ToolBodyFragment } from './tool-result-types.js';

export const INLINE_RESULT_BYTES = 65_536;
export const MAX_RESULT_BYTES = 1_048_576;
const HALF = MAX_RESULT_BYTES / 2;
const ALIGNMENT = 16_384;

/** Encode bounded windows, including when one input string is much larger than the cap. */
function windows(text: string): Iterable<Buffer> {
  return {
    *[Symbol.iterator]() {
      for (let start = 0; start < text.length;) {
        let end = Math.min(text.length, start + 32_768);
        const last = text.charCodeAt(end - 1);
        if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
        yield Buffer.from(text.slice(start, end));
        start = end;
      }
    },
  };
}
function continuation(byte: number | undefined): boolean {
  return byte !== undefined && (byte & 0xc0) === 0x80;
}
function select(
  texts: readonly string[],
  start: number,
  end: number,
): ToolBodyFragment {
  const pieces: Buffer[] = [];
  let offset = 0;
  let actualStart = start;
  let actualEnd = start;
  for (const text of texts) {
    const size = Buffer.byteLength(text);
    if (offset + size <= start) {
      offset += size;
      continue;
    }
    if (offset >= end) break;
    for (const chunk of windows(text)) {
      let left = Math.max(0, start - offset);
      let right = Math.min(chunk.length, end - offset);
      while (left < right && continuation(chunk[left])) left += 1;
      while (right > left && continuation(chunk[right])) right -= 1;
      if (left < right) {
        if (pieces.length === 0) actualStart = offset + left;
        pieces.push(chunk.subarray(left, right));
        actualEnd = offset + right;
      }
      offset += chunk.length;
      if (offset >= end) break;
    }
  }
  return {
    start: actualStart,
    end: actualEnd,
    text: Buffer.concat(pieces).toString('utf8'),
  };
}
function align(
  fragment: ToolBodyFragment,
  head: boolean,
  boundaries: readonly number[],
): ToolBodyFragment {
  const body = Buffer.from(fragment.text);
  const boundary = head
    ? boundaries.findLast(
        (at) => at <= fragment.end && at > fragment.end - ALIGNMENT,
      )
    : boundaries.find(
        (at) => at >= fragment.start && at < fragment.start + ALIGNMENT,
      );
  const line = head ? body.lastIndexOf(10) + 1 : body.indexOf(10) + 1;
  let cut = boundary === undefined ? -1 : boundary - fragment.start;
  if (cut <= 0 || cut >= body.length) {
    cut =
      line > 0 && (head ? line >= body.length - ALIGNMENT : line <= ALIGNMENT)
        ? line
        : -1;
  }
  if (cut <= 0 || cut >= body.length) return fragment;
  return head
    ? {
        start: fragment.start,
        end: fragment.start + cut,
        text: body.subarray(0, cut).toString('utf8'),
      }
    : {
        start: fragment.start + cut,
        end: fragment.end,
        text: body.subarray(cut).toString('utf8'),
      };
}
export function sliceResultBody(texts: readonly string[]): {
  readonly sourceBytes: number;
  readonly body: Buffer;
  readonly fragments: readonly ToolBodyFragment[];
} {
  let total = 0;
  const boundaries = texts.map((text) => {
    total += Buffer.byteLength(text);
    return total;
  });
  if (total === 0)
    return { sourceBytes: 0, body: Buffer.alloc(0), fragments: [] };
  const fragments =
    total <= MAX_RESULT_BYTES
      ? [select(texts, 0, total)]
      : [
          align(select(texts, 0, HALF), true, boundaries),
          align(select(texts, total - HALF, total), false, boundaries),
        ];
  return {
    sourceBytes: total,
    body: Buffer.from(fragments.map((fragment) => fragment.text).join('')),
    fragments,
  };
}
