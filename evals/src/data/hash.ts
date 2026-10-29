/**
 * The input hash a label is approved against.
 *
 * The hash covers the case input only — never the case id, family, split or
 * provenance — so editing an input invalidates exactly the labels that judged it,
 * and moving a case between families does not. Keys are sorted and the encoding is
 * one canonical string, so the same input always hashes the same way regardless of
 * the key order in the file it was read from.
 *
 * An input that cannot be canonicalised is refused rather than guessed at: a
 * silently skipped key would make two different inputs share a hash.
 */

import { createHash } from 'node:crypto';

/** Serialise one JSON value with sorted object keys and no insignificant space. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return numberJson(value);
  if (Array.isArray(value)) {
    return `[${value.map((item: unknown) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') return objectJson(value);
  throw new TypeError(`cannot canonicalise a ${typeof value}`);
}

function numberJson(value: number): string {
  if (!Number.isFinite(value)) {
    throw new TypeError(
      `cannot canonicalise non-finite number ${String(value)}`,
    );
  }
  // JSON has no -0; normalising keeps 0 and -0 from hashing differently.
  return JSON.stringify(value === 0 ? 0 : value);
}

function objectJson(value: object): string {
  const entries = Object.entries(value).filter(
    ([, item]) => item !== undefined,
  );
  entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  const body = entries
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',');
  return `{${body}}`;
}

/** The `sha256:<hex>` digest of one canonical JSON document. */
export function digestOf(value: unknown): string {
  return sha256Text(canonicalJson(value));
}

/**
 * The `sha256:<hex>` digest of text exactly as it stands.
 *
 * A digest recorded against a committed prose document is over its bytes, so it
 * matches what `sha256sum` prints on the file and a reader can re-derive it without
 * this module. That is deliberately different from hashing a value through
 * {@link canonicalJson}.
 */
export function sha256Text(text: string): string {
  return `sha256:${createHash('sha256').update(text, 'utf8').digest('hex')}`;
}
