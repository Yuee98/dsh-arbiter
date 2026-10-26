/** Canonical single-quote rendering for a statically known shell word. */
const BARE = /^[A-Za-z0-9_@%+=:,./-]+$/u;

/**
 * Whether a static value can be used as a filesystem path without re-parsing.
 *
 * The canonical matching text is a *quoted command fragment*: `touch "/tmp/a b"`
 * becomes `touch '/tmp/a b'`, and the leading quote is part of the text, not of
 * the path. Only the decoded value may be resolved as a path, and only when it
 * cannot be mistaken for an option or an unresolved expression.
 */
export function isPlainPathValue(value: string): boolean {
  return (
    value.length > 0 &&
    !value.startsWith('-') &&
    !value.includes('\u0000') &&
    !value.includes('\uFFFD')
  );
}

/**
 * Render one decoded word so the matching text is stable and unambiguously one
 * argument.
 *
 * A bare form is used only for characters that carry no shell meaning; anything
 * else is single-quoted, which preserves spaces, empty words and literal
 * metacharacters without re-interpreting them. An embedded single quote is
 * written as `'\''`, the only way to keep it inside a single-quoted word.
 */
export function quoteStaticWord(value: string): string {
  if (value.length > 0 && BARE.test(value)) return value;
  return `'${value.split("'").join("'\\''")}'`;
}
