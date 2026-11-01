/** Head/tail fragments are visibly incomplete, never executable replacements. */
export interface TextFragment {
  readonly head: string;
  readonly tail: string;
  readonly omittedFrom: number;
  readonly omittedTo: number;
  readonly retainedChars: number;
}

export function textFragment(text: string, keep: number): TextFragment {
  if (keep >= text.length)
    return {
      head: text,
      tail: '',
      omittedFrom: text.length,
      omittedTo: text.length - 1,
      retainedChars: text.length,
    };
  let headEnd = Math.floor(Math.max(0, keep) / 2);
  let tailStart = text.length - (Math.max(0, keep) - headEnd);
  // Never split surrogate pairs. Line alignment may only reduce retained text.
  if (headEnd > 0 && /[\uD800-\uDBFF]/u.test(text.charAt(headEnd - 1)))
    headEnd -= 1;
  if (/[\uDC00-\uDFFF]/u.test(text.charAt(tailStart))) tailStart += 1;
  const headLine = text.lastIndexOf('\n', headEnd - 1);
  const tailLine = text.indexOf('\n', tailStart);
  if (headLine >= headEnd / 2) headEnd = headLine + 1;
  if (tailLine >= 0 && tailLine - tailStart < (text.length - tailStart) / 2)
    tailStart = tailLine + 1;
  return {
    head: text.slice(0, headEnd),
    tail: text.slice(tailStart),
    omittedFrom: headEnd,
    omittedTo: tailStart - 1,
    retainedChars: headEnd + text.length - tailStart,
  };
}

export function shortenedText(text: string, keep: number): string {
  if (keep >= text.length) return text;
  const fragment = textFragment(text, keep);
  return `${fragment.head}\n[... middle omitted by input budget; text fragment ...]\n${fragment.tail}`;
}

export function jsonFragment(value: unknown, scale: number): unknown {
  if (scale >= 1) return value;
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return {
    format: typeof value === 'string' ? 'text-fragment' : 'json-fragment',
    note: 'Incomplete review copy; not a complete object or command.',
    ...textFragment(text, Math.floor(text.length * Math.max(0, scale))),
  };
}
