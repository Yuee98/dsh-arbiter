import type { Translate } from './i18n.js';

/** One issue as the API carries it: a path, a stable code and its parameters. */
export interface ConfigIssueView {
  readonly path: string;
  readonly message: string;
  readonly code?: string;
  readonly params?: Readonly<Record<string, string | number>>;
}

/** Locale keys must start with a lowercase letter and use no separators. */
export function issueKey(code: string): string {
  const parts = code.split(/[^A-Za-z0-9]+/u);
  const [first = '', ...rest] = parts;
  return [
    first.toLowerCase(),
    ...rest.map((part) => part.slice(0, 1).toUpperCase() + part.slice(1)),
  ].join('');
}

/**
 * Translate a plugin-generated issue through its stable code.
 *
 * Paths, interpolated parameters and raw backend messages stay data: only the
 * sentence template is localized. An unmapped code falls back to the backend
 * message instead of showing a raw translation key.
 */
export function issueText(issue: ConfigIssueView, t: Translate): string {
  // A payload without a stable code keeps its backend message.
  if (issue.code === undefined) return plainIssue(issue);
  const params = issue.params ?? {};
  const key = `config.issue.${issueKey(issue.code)}`;
  const template = t(key, params);
  // An unmapped code renders its backend message rather than a bare key.
  if (template === key || template.length === 0) return plainIssue(issue);
  return issue.path.length === 0 ? template : `${issue.path}: ${template}`;
}

function plainIssue(issue: ConfigIssueView): string {
  return issue.path.length === 0
    ? issue.message
    : `${issue.path}: ${issue.message}`;
}

export function issuesText(
  issues: readonly ConfigIssueView[],
  t: Translate,
): string {
  return issues.map((issue) => issueText(issue, t)).join('\n');
}
