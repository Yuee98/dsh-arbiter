/** Keep actual production strings readable, without interpreting markup. */
export function materialSections(request: unknown): readonly {
  readonly key: string;
  readonly lines: readonly string[];
  readonly offset: number;
}[] {
  const entries: readonly [string, unknown][] =
    request !== null && typeof request === 'object' && !Array.isArray(request)
      ? Object.entries(request)
      : [['productionRequest', request]];
  const rank = (key: string) =>
    key === 'user' || key === 'state' ? 0 : key === 'system' ? 2 : 1;
  let offset = 0;
  return [...entries]
    .sort(([left], [right]) => rank(left) - rank(right))
    .map(([key, value]) => {
      const text =
        typeof value === 'string' ? value : JSON.stringify(value, null, 2);
      const lines = text.split('\n');
      const result = { key, lines, offset: offset + 1 };
      offset += lines.length + 2;
      return result;
    });
}
export function materialLines(request: unknown): readonly string[] {
  return materialSections(request).flatMap((section) => [
    section.key,
    ...section.lines,
    '',
  ]);
}
