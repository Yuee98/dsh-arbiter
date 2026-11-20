const headings = new Set([
  'POLICY_AND_GUIDANCE',
  'ENVIRONMENT',
  'PARENT_HUMAN_EVIDENCE',
  'SESSION_TIMELINE',
  'HUMAN_AUTHORIZATION',
  'TURN_TOOL_HISTORY',
  'PRIOR_VERDICTS',
  'PENDING_ACTION',
  'ACTION_FACTS',
  'REVIEW_HINT',
  'MATERIAL_COMPLETENESS',
]);

export function fields(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? { ...value }
    : {};
}

export function entries(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? value : [];
}

export function asText(value: unknown): string {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value, null, 2);
}

/** The production renderer indents JSON fields and escapes embedded newlines. */
export function materialBlocks(
  lines: readonly string[],
): ReadonlyMap<string, string> {
  const starts: { key: string; index: number }[] = [];
  for (const [index, line] of lines.entries()) {
    if (headings.has(line) && (index === 0 || lines[index - 1] === ''))
      starts.push({ key: line, index });
  }
  // Project rules are free text. Find the structural environment block after
  // them using the surrounding production headings.
  const environment = starts.findLastIndex(
    ({ key, index }) => key === 'ENVIRONMENT' && lines[index + 1] === '{',
  );
  if (environment < 0) return new Map();
  const blocks = new Map(
    starts.slice(environment).map(({ key, index }, position) => [
      key,
      lines
        .slice(index + 1, starts[environment + position + 1]?.index)
        .join('\n')
        .trimEnd(),
    ]),
  );
  const policy = starts.find(({ key }) => key === 'POLICY_AND_GUIDANCE');
  if (policy !== undefined) {
    blocks.set(
      'POLICY_AND_GUIDANCE',
      lines
        .slice(policy.index + 2, starts[environment]?.index)
        .join('\n')
        .trimEnd(),
    );
  }
  return blocks.has('PENDING_ACTION') ? blocks : new Map();
}

/** Some sections begin with a production note, or end with an omission note. */
export function materialFields(
  text: string | undefined,
): Record<string, unknown> {
  if (text === undefined) return {};
  const lines = text.split('\n');
  const first = lines.indexOf('{');
  const last = lines.lastIndexOf('}');
  if (first < 0 || last < first) return {};
  try {
    const parsed: unknown = JSON.parse(lines.slice(first, last + 1).join('\n'));
    return fields(parsed);
  } catch {
    return {};
  }
}
