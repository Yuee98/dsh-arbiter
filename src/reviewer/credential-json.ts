/** Map an already sanitized JSON tree onto its original scalar token positions. */
import type { CredentialSpan } from './credential-literals.js';

export function jsonCopySpans(
  text: string,
  cleaned: unknown,
  cleanKey: (key: string, path: readonly string[]) => string,
): CredentialSpan[] {
  const spans: CredentialSpan[] = [];
  const token =
    /"(?:\\.|[^"\\])*"|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/gy;
  let cursor = 0;
  let nodes = 0;
  const fail = (): never => {
    throw new Error('credential JSON source could not be safely mapped');
  };
  const skip = (): void => {
    while (/\s/u.test(text[cursor] ?? '') && cursor < text.length) cursor += 1;
  };
  const scalar = (
    value?: unknown,
    key = false,
    path: readonly string[] = [],
  ): string => {
    skip();
    token.lastIndex = cursor;
    const match = token.exec(text);
    if (match === null) return fail();
    const original: unknown = JSON.parse(match[0]);
    const next =
      key && typeof original === 'string' ? cleanKey(original, path) : value;
    if (next === undefined) return fail();
    const replacement = JSON.stringify(next);
    if (original !== next)
      spans.push({ start: cursor, end: token.lastIndex, marker: replacement });
    cursor = token.lastIndex;
    return typeof original === 'string' ? original : '';
  };
  const member = (
    value: object,
    keys: Set<string>,
    depth: number,
    path: readonly string[],
  ): void => {
    const name = scalar(undefined, true, path);
    const safeName = cleanKey(name, path);
    // Duplicate/colliding keys cannot be mapped back without ambiguity.
    if (keys.has(safeName) || !Object.hasOwn(value, safeName)) fail();
    keys.add(safeName);
    skip();
    if (text[cursor] !== ':') fail();
    cursor += 1;
    visit(Reflect.get(value, safeName), depth + 1, [...path, name]);
  };
  const visit = (
    value: unknown,
    depth: number,
    path: readonly string[],
  ): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64) fail();
    skip();
    const opening = text[cursor];
    if (opening !== '{' && opening !== '[') {
      scalar(value);
      return;
    }
    if (value === null || typeof value !== 'object') return fail();
    const array = opening === '[';
    if (array !== Array.isArray(value)) fail();
    const closing = array ? ']' : '}';
    const keys = new Set<string>();
    let index = 0;
    cursor += 1;
    skip();
    while (text[cursor] !== closing) {
      if (index > 0) {
        if (text[cursor] !== ',') fail();
        cursor += 1;
      }
      if (array) {
        visit(Reflect.get(value, index), depth + 1, [...path, String(index)]);
      } else {
        member(value, keys, depth, path);
      }
      index += 1;
      skip();
    }
    if (Object.keys(value).length !== index) fail();
    cursor += 1;
  };
  visit(cleaned, 0, []);
  skip();
  if (cursor !== text.length) fail();
  return spans;
}
