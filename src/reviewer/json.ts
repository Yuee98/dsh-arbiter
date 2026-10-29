/**
 * Reading a JSON object out of model prose.
 *
 * A chat model may answer inside a fence, or add a sentence before the object.
 * Both are format noise around one object, so both are removed here — one helper
 * for both chat readers (the legacy adapter and the reviewer service), because
 * two extractors would accept two different output sets under one contract.
 */

/**
 * The JSON object this text contains, or the trimmed text when it contains none.
 *
 * The last `}` is used rather than the first, because a nested object closes
 * before the outer one does and cutting at the first would return a fragment.
 */
export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}
