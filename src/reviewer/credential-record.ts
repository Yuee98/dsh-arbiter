/** A transformed record must never silently discard a source member. */
export function uniqueCredentialRecord(
  entries: Iterable<readonly [string, unknown]>,
): Record<string, unknown> {
  const seen = new Set<string>();
  const retained: [string, unknown][] = [];
  for (const [key, value] of entries) {
    if (seen.has(key))
      throw new Error('credential material has ambiguous transformed keys');
    seen.add(key);
    retained.push([key, value]);
  }
  return Object.fromEntries(retained);
}
