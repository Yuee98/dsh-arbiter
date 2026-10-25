/**
 * Pure rule-draft operations shared by the list and the editor.
 *
 * Everything here works on the page's draft only: creating, copying and moving
 * rules never touches the effective configuration, and an id is generated once
 * at creation so later edits keep it stable. Translation is passed in, so the
 * auto summary follows the host language instead of a hardcoded sentence.
 */

import type { RuleCondition, RuleKind, RuleTarget } from '../../../types.js';
import type { Translate } from '../../i18n.js';
import type { ConfigIssueView } from '../../view-issues.js';
import type { Draft, DraftRule } from '../../view-types.js';

export type MutableRuleCondition = Draft['rules'][number]['conditions'][number];

/** One validation finding attached to a rule, with its rule-relative field. */
export interface RuleIssue {
  readonly issue: ConfigIssueView;
  readonly field: string;
  readonly severity: 'error' | 'warning';
}

export type RuleVerdictValue = DraftRule['verdict'];

const TARGET_LABEL_KEY: Readonly<Record<RuleTarget, string>> = {
  command: 'rules.targetOption.command',
  file_redirect: 'rules.targetOption.fileRedirect',
  variable_assignment: 'rules.targetOption.variableAssignment',
  tool: 'rules.targetOption.tool',
  argument: 'rules.targetOption.argument',
};

const KIND_LABEL_KEY: Readonly<Record<RuleKind, string>> = {
  exact: 'rules.kindOption.exact',
  regex: 'rules.kindOption.regex',
  glob: 'rules.kindOption.glob',
};

export const VERDICT_LABEL_KEY: Readonly<Record<RuleVerdictValue, string>> = {
  deny: 'rules.verdictOption.deny',
  'force-ask': 'rules.verdictOption.forceAsk',
  'force-review': 'rules.verdictOption.forceReview',
  allow: 'rules.verdictOption.allow',
};

/** The fixed display order: deny, force-ask, force-review, allow. */
export const VERDICT_ORDER: readonly RuleVerdictValue[] = [
  'deny',
  'force-ask',
  'force-review',
  'allow',
];

/**
 * The default condition for a target.
 *
 * A new command condition is a whole-value RE2 expression; a tool-argument
 * condition defaults to an exact match because the selected JSON value keeps
 * its own type.
 */
export function defaultCondition(target: RuleTarget = 'command') {
  return target === 'argument'
    ? { target, kind: 'exact' as const, pattern: '' }
    : { target, kind: 'regex' as const, pattern: '' };
}

/** The JSON spelling of a typed pattern, for display and editing. */
export function patternText(pattern: RuleCondition['pattern']): string {
  return typeof pattern === 'string' ? pattern : JSON.stringify(pattern);
}

/** An exact pattern's JSON type, which decides the value editor. */
export function exactType(
  pattern: RuleCondition['pattern'],
): 'string' | 'number' | 'boolean' | 'null' {
  if (pattern === null) return 'null';
  if (typeof pattern === 'number') return 'number';
  if (typeof pattern === 'boolean') return 'boolean';
  return 'string';
}

/**
 * Convert the current pattern to another exact JSON type.
 *
 * Parseable literals keep their meaning (`'true'` becomes `true`, `'42'`
 * becomes `42`); text that cannot be represented in the target type is left
 * unchanged rather than replaced by an unrelated default. Turning a typed value
 * into text keeps its JSON spelling, which is what that value is written as.
 */
export function convertExactPattern(
  pattern: RuleCondition['pattern'],
  type: 'string' | 'number' | 'boolean' | 'null',
): RuleCondition['pattern'] {
  if (type === 'null') return null;
  // A blank or whitespace-only expression carries no value to convert. Writing
  // `0`/`false` here would invent a match the user never entered, so the
  // expression is left untouched and the editor withholds the type choice.
  if (patternText(pattern).trim().length === 0) return pattern;
  if (type === 'boolean') {
    if (typeof pattern === 'boolean') return pattern;
    const text = patternText(pattern).trim();
    if (text === 'true') return true;
    if (text === 'false') return false;
    return pattern;
  }
  if (type === 'number') {
    if (typeof pattern === 'number') return pattern;
    const parsed = Number(patternText(pattern).trim());
    return Number.isFinite(parsed) ? parsed : pattern;
  }
  return typeof pattern === 'string' ? pattern : patternText(pattern);
}

/** A rule id that is not used yet; renaming or editing never regenerates it. */
export function nextRuleId(rules: readonly DraftRule[]): string {
  const used = new Set(rules.map((rule) => rule.id));
  let counter = 1;
  while (used.has(`rule-${String(counter)}`)) counter += 1;
  return `rule-${String(counter)}`;
}

/**
 * A new rule starts enabled with `force-review`, which is the safe direction:
 * it only routes matching calls into review until the user chooses otherwise.
 */
export function createRule(rules: readonly DraftRule[]): DraftRule {
  return {
    id: nextRuleId(rules),
    conditions: [defaultCondition()],
    verdict: 'force-review',
    enabled: true,
    comment: '',
  };
}

/**
 * Copy keeps the scope, conditions, verdict and comment, but never the id, and
 * the copy starts disabled so duplicating cannot silently widen the policy.
 */
export function duplicateRule(
  rule: DraftRule,
  rules: readonly DraftRule[],
): DraftRule {
  return {
    id: nextRuleId(rules),
    conditions: rule.conditions.map((condition) => ({ ...condition })),
    verdict: rule.verdict,
    enabled: false,
    comment: rule.comment ?? '',
    ...(rule.scope === undefined
      ? {}
      : {
          scope: {
            ...(rule.scope.tools === undefined
              ? {}
              : { tools: [...rule.scope.tools] }),
            ...(rule.scope.agents === undefined
              ? {}
              : { agents: [...rule.scope.agents] }),
          },
        }),
    ...(rule.hint === undefined ? {} : { hint: rule.hint }),
  };
}

/**
 * Where a move would go: the nearest rule with the same verdict.
 *
 * "Inside one priority" is the design's constraint, not physical adjacency. A
 * rule may step past rules of another verdict; it must not cross into a
 * different priority. Intermediate rules keep their relative order.
 */
export function moveTarget(
  rules: readonly DraftRule[],
  index: number,
  direction: -1 | 1,
): number | null {
  const current = rules[index];
  if (current === undefined) return null;
  for (
    let candidate = index + direction;
    candidate >= 0 && candidate < rules.length;
    candidate += direction
  ) {
    if (rules[candidate]?.verdict === current.verdict) return candidate;
  }
  return null;
}

export function canMoveRule(
  rules: readonly DraftRule[],
  index: number,
  direction: -1 | 1,
): boolean {
  return moveTarget(rules, index, direction) !== null;
}

/** Swap the rule with the nearest same-verdict rule. */
export function moveRule(
  rules: DraftRule[],
  index: number,
  direction: -1 | 1,
): void {
  const target = moveTarget(rules, index, direction);
  const current = rules[index];
  const other = target === null ? undefined : rules[target];
  if (target === null || current === undefined || other === undefined) return;
  rules[index] = other;
  rules[target] = current;
}

function splitList(value: string): readonly string[] {
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

export function listText(value: readonly string[] | undefined): string {
  return (value ?? []).join(', ');
}

export function listValue(value: string): readonly string[] {
  return splitList(value);
}

function conditionSummary(condition: RuleCondition, t: Translate): string {
  const target = t(TARGET_LABEL_KEY[condition.target]);
  const kind = t(KIND_LABEL_KEY[condition.kind]);
  const text = patternText(condition.pattern);
  const base =
    text.length === 0
      ? t('rules.summaryConditionEmpty', { target, kind })
      : t('rules.summaryCondition', { target, kind, pattern: text });
  return condition.caseSensitive === false
    ? t('rules.summaryIgnoreCase', { text: base })
    : base;
}

/** The scope part of the summary: tools and agents, in that order. */
function scopeSummary(rule: DraftRule): string {
  return [...(rule.scope?.tools ?? []), ...(rule.scope?.agents ?? [])].join(
    ' · ',
  );
}

/**
 * The automatic display name.
 *
 * It follows the scope and conditions, so editing a condition updates the name
 * unless the user supplied a custom one. Only the first condition is spelled
 * out; the rest are counted.
 */
export function ruleSummary(rule: DraftRule, t: Translate): string {
  const first = rule.conditions[0];
  const text =
    first === undefined
      ? t('rules.summaryNoConditions')
      : rule.conditions.length > 1
        ? t('rules.summaryMore', {
            text: conditionSummary(first, t),
            count: rule.conditions.length,
          })
        : conditionSummary(first, t);
  const scope = scopeSummary(rule);
  return scope.length === 0 ? text : t('rules.summaryScoped', { scope, text });
}

/** The custom name when present, otherwise the auto summary. */
export function ruleName(rule: DraftRule, t: Translate): string {
  const custom = rule.name?.trim() ?? '';
  return custom.length === 0 ? ruleSummary(rule, t) : custom;
}

/**
 * Attach backend findings to this rule.
 *
 * Errors are addressed as `rules[<index>]…`; warnings use `rules.<id>`, because
 * a shadowing warning is about the rule's identity rather than a position.
 */
export function ruleIssues(
  issues: readonly RuleIssue[],
  rule: DraftRule,
  index: number,
): readonly RuleIssue[] {
  return issues.flatMap((entry) => {
    const { issue } = entry;
    const indexed = /^rules\[(\d+)\]/u.exec(issue.path);
    if (indexed !== null) {
      if (Number(indexed[1]) !== index) return [];
      return [{ ...entry, field: ruleIssueField(issue, index) }];
    }
    // The shadowing warning addresses a rule by its exact id. A dotted id such
    // as `a.b` must not be read as a field path of rule `a`, so this compares
    // the whole id instead of accepting a prefix.
    const named = /^rules\.(.+)$/u.exec(issue.path);
    if (named === null || named[1] !== rule.id) return [];
    return [{ ...entry, field: rule.id }];
  });
}

/** The field part of an indexed issue path, relative to the rule. */
export function ruleIssueField(issue: ConfigIssueView, index: number): string {
  const prefix = `rules[${String(index)}]`;
  if (issue.path === prefix) return '';
  if (issue.path.startsWith(`${prefix}.`))
    return issue.path.slice(prefix.length + 1);
  if (issue.path.startsWith('rules.')) return issue.path.slice('rules.'.length);
  return issue.path;
}

/** A field's own message, for the rule editor's localized field hint. */
export function ruleFieldLabel(field: string): string {
  return field.replace(/^conditions\[(\d+)\]\./u, '');
}

/** The canonical declaration a canonical rule needs in its document. */
export const CANONICAL_FORMAT = 'arbiter-config-v2';

/** Append a rule to the draft and declare the format its structure requires. */
export function addRule(draft: Draft): DraftRule {
  const rule = createRule(draft.rules);
  draft.rules.push(rule);
  draft.format = CANONICAL_FORMAT;
  return rule;
}

/** Insert a copy right after its source, disabled, with a fresh id. */
export function addDuplicate(draft: Draft, source: DraftRule): DraftRule {
  const copy = duplicateRule(source, draft.rules);
  const index = draft.rules.findIndex((rule) => rule.id === source.id);
  draft.rules.splice(index < 0 ? draft.rules.length : index + 1, 0, copy);
  draft.format = CANONICAL_FORMAT;
  return copy;
}

/**
 * Find a rule by id rather than position.
 *
 * Rows may be reordered or removed between a render and an edit, and the id is
 * the one stable identity the draft guarantees.
 */
export function withRule(
  draft: Draft,
  id: string,
  mutator: (rule: DraftRule) => void,
): void {
  const rule = draft.rules.find((candidate) => candidate.id === id);
  if (rule !== undefined) mutator(rule);
}

export function withCondition(
  conditions: DraftRule['conditions'],
  index: number,
  mutator: (condition: MutableRuleCondition) => void,
): void {
  const condition = conditions[index];
  if (condition === undefined) return;
  mutator(condition);
}

/** Grow the condition list with the same defaults a new rule uses. */
export function addCondition(
  conditions: Draft['rules'][number]['conditions'],
): void {
  conditions.push(defaultCondition());
}
