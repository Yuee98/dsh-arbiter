/**
 * Rule-tester view logic.
 *
 * The tester explains what the shared evaluator answered; it never re-derives a
 * match. Everything here reads a decoded `/api/arbiter/test` answer and decides
 * which sentence applies, which rule the answer is about, and when a result has
 * gone stale. Keeping that pure lets the React layer stay a rendering layer and
 * lets Node tests cover the explanation contract.
 */

import type {
  RuleConditionResult,
  RuleConjunctionGroup,
  RuleMatchDetail,
  RuleResult,
  RuleVerdict,
  SessionKind,
} from '../../../types.js';
import type { Translate } from '../../i18n.js';
import type { DraftRule, RuleTestResultView } from '../../view-types.js';

/** The two input shapes the tester accepts. */
export type TestInputMode = 'command' | 'arguments';

/** What the operator typed, before it becomes a call. */
export interface TestInput {
  readonly tool: string;
  readonly identity: SessionKind;
  readonly mode: TestInputMode;
  readonly text: string;
}

/** One call submitted to the tester; `input` is its display form. */
export interface TestSample {
  readonly tool: string;
  readonly args: unknown;
  readonly input: string;
}

/**
 * Why a sample cannot be evaluated.
 *
 * Each problem belongs to a specific control: a missing tool and a malformed
 * JSON document are input problems, never a rule result. The component renders
 * them next to that control instead of as "no rule matched".
 */
export type SampleProblem =
  | { readonly kind: 'tool-required' }
  | { readonly kind: 'command-required' }
  | { readonly kind: 'json-syntax'; readonly message: string }
  | { readonly kind: 'json-shape' };

export type SampleBuild =
  | { readonly ok: true; readonly sample: TestSample }
  | { readonly ok: false; readonly problem: SampleProblem };

/**
 * Turn the typed sample into the call the evaluator sees.
 *
 * Command text is passed through unchanged: normalizing it is the shell
 * reader's job (#8), and doing it here would give the tester a different command
 * from the gate's. Argument JSON is parsed so a syntax error is located at the
 * input rather than becoming a non-match.
 */
export function buildSample(input: TestInput): SampleBuild {
  const tool = input.tool.trim();
  if (tool.length === 0)
    return { ok: false, problem: { kind: 'tool-required' } };
  if (input.mode === 'command') {
    if (input.text.trim().length === 0)
      return { ok: false, problem: { kind: 'command-required' } };
    return {
      ok: true,
      sample: { tool, args: { command: input.text }, input: input.text },
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(input.text);
  } catch (error) {
    return {
      ok: false,
      problem: {
        kind: 'json-syntax',
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return { ok: false, problem: { kind: 'json-shape' } };
  return { ok: true, sample: { tool, args: parsed, input: input.text } };
}

/** How the selected rule's own evaluation ended. */
export type RuleState =
  'match' | 'no-match' | 'unknown' | 'scope' | 'disabled' | 'not-tested';

export interface RuleConclusion {
  readonly state: RuleState;
  readonly result: RuleResult | null;
}

/**
 * The selected rule's own conclusion, separate from the whole-draft path.
 *
 * A disabled rule and a rule whose scope excludes this call both evaluate to
 * "scope" conditions; the draft tells them apart, so the panel can say which one
 * happened instead of showing a plain non-match.
 */
export function ruleConclusion(
  result: RuleTestResultView,
  rule: DraftRule | null,
): RuleConclusion {
  if (rule === null) return { state: 'not-tested', result: null };
  const evaluated = result.rules.find((entry) => entry.id === rule.id) ?? null;
  if (evaluated === null) return { state: 'not-tested', result: null };
  if (evaluated.conditions.every((condition) => condition.reason === 'scope'))
    return {
      state: rule.enabled === false ? 'disabled' : 'scope',
      result: evaluated,
    };
  return { state: evaluated.outcome, result: evaluated };
}

/** Why the whole draft did not pick a configured verdict. */
export type ReviewReason =
  'no-match' | 'incomplete' | 'unresolved' | 'partial-allow';

/** The whole-draft path, read from the evaluator's own detail. */
export type FinalPath =
  | {
      readonly kind: 'rule';
      readonly verdict: RuleVerdict;
      readonly ruleId: string;
      readonly hint?: string;
    }
  | { readonly kind: 'review'; readonly reason: ReviewReason };

export function finalPath(result: RuleTestResultView): FinalPath {
  const detail = result.pathDetail;
  if (detail.kind === 'rule')
    return {
      kind: 'rule',
      verdict: detail.verdict,
      ruleId: detail.ruleId,
      ...(detail.hint === undefined ? {} : { hint: detail.hint }),
    };
  return { kind: 'review', reason: detail.reason };
}

/** One condition, with the values the selector actually returned. */
export interface ConditionView {
  readonly index: number;
  readonly condition: RuleConditionResult;
  /** `any`/`all` only applies to a selected-value condition. */
  readonly multi: 'any' | 'all' | null;
  readonly values: readonly unknown[];
  readonly matchedValues: readonly unknown[];
  /**
   * The node that satisfied this condition *and* its siblings on the same
   * target, when the rule used `all`.
   *
   * Without it a matched condition in a conjunction reads as if it alone decided
   * the rule, which is the narrower claim the user did not write.
   */
  readonly witness: string | null;
  /** The conjunction group this condition belongs to, when the rule used `all`. */
  readonly group: RuleConjunctionGroup | null;
}

export function conditionViews(result: RuleResult): readonly ConditionView[] {
  return result.conditions.map((condition) => {
    const group =
      result.groups?.find((entry) =>
        entry.conditionIndices.includes(condition.index),
      ) ?? null;
    return {
      index: condition.index,
      condition,
      multi:
        condition.target === 'argument' ? (condition.multi ?? 'any') : null,
      values: condition.values ?? [],
      matchedValues: condition.matchedValues ?? [],
      witness: condition.witnessValues?.[0] ?? null,
      group,
    };
  });
}

/**
 * Why the whole-draft path is not the selected rule's verdict.
 *
 * `shadowed` lists rules that matched but were outranked; `unknown` lists rules
 * whose evaluation was undecided, which is what keeps an `allow` from deciding.
 * Both are what the evaluator produced — the panel never recomputes priority.
 */
export interface CoverageView {
  readonly shadowed: readonly RuleMatchDetail[];
  readonly unknown: readonly string[];
  readonly reviewReason: ReviewReason | null;
  readonly allowMatched: boolean;
}

export function coverageView(result: RuleTestResultView): CoverageView {
  const path = finalPath(result);
  return {
    shadowed: result.matches.filter((match) => !match.effective),
    unknown: result.rules
      .filter((entry) => entry.outcome === 'unknown')
      .map((entry) => entry.id),
    reviewReason: path.kind === 'review' ? path.reason : null,
    allowMatched: result.rules.some(
      (entry) => entry.verdict === 'allow' && entry.outcome === 'match',
    ),
  };
}

/** A localized verdict label; the protocol value itself stays visible. */
export function verdictLabel(verdict: RuleVerdict, t: Translate): string {
  switch (verdict) {
    case 'allow':
      return t('rules.verdictOption.allow');
    case 'deny':
      return t('rules.verdictOption.deny');
    case 'force-ask':
      return t('rules.verdictOption.forceAsk');
    case 'force-review':
      return t('rules.verdictOption.forceReview');
  }
}

/**
 * One level of the fixed whole-config precedence, as this answer used it.
 *
 * `decision` says what this level contributed to *this* call: the winning level,
 * a level whose rule matched but was outranked, or a level that never applied.
 * It is read from the evaluator's own path and outcomes, so the list explains
 * priority without recomputing it.
 */
export interface PriorityLevel {
  readonly kind: 'rule' | 'fallback';
  readonly verdict: RuleVerdict | null;
  readonly decision: 'effective' | 'matched' | 'blocked' | 'none';
  /** Ids at this level that matched, in evaluator order. */
  readonly ruleIds: readonly string[];
  /** True when the focused rule sits at this level and took part. */
  readonly focused: boolean;
}

/** One command text the call offered, and whether an allow condition named it. */
export interface CoverageNode {
  readonly text: string;
  readonly named: boolean;
}

/**
 * How the evaluator classified coverage, taken from its own path.
 *
 * This is deliberately not re-derived: `matches[].effective` is set before the
 * final path is chosen, so a matched `allow` can carry `effective: true` while
 * the call actually went to `review(default)` because it did not cover
 * everything. Only `pathDetail` says what coverage was credited, so only
 * `pathDetail` decides which sentence the panel may state.
 */
export type CoverageState =
  'complete' | 'partial' | 'incomplete' | 'not-allow' | 'no-structure';

/**
 * What the call offered and what the evaluator credited an `allow` with.
 *
 * A composite command is the case the contract calls out: allowing `gh pr view`
 * says nothing about the `rm` after `&&`. The node list is evidence of which
 * commands an `allow` condition named; it is never used to compute the
 * classification, which comes from `pathDetail` and `parse.completeness`.
 *
 * The texts come from the parse the evaluator used (`normalization.commands`),
 * never from re-parsing here: a second parser could describe a different command
 * than the one that decided the answer.
 */
export interface CoverageDetail {
  /** Command texts the parse published, with whether an allow condition named them. */
  readonly nodes: readonly CoverageNode[];
  readonly total: number;
  readonly namedCount: number;
  /** The classification the evaluator actually produced. */
  readonly state: CoverageState;
  /** True when this call has a shell structure at all. */
  readonly structural: boolean;
}

/**
 * The command texts an `allow` condition actually named.
 *
 * Read from the rule outcomes rather than from `matches[].effective`: a shadowed
 * allow names commands it was never allowed to cover, and hiding it would remove
 * the evidence for why the call was not released.
 */
function allowNamedTexts(result: RuleTestResultView): ReadonlySet<string> {
  const named = new Set<string>();
  for (const entry of result.rules) {
    if (entry.verdict !== 'allow' || entry.outcome !== 'match') continue;
    for (const condition of entry.conditions) {
      if (condition.outcome !== 'match') continue;
      // `witnessValues` is authoritative for an `all` conjunction: a condition
      // that matched a node no sibling matched does not cover it.
      for (const text of condition.witnessValues ?? []) named.add(text);
      // An `any` rule covers what each matched condition named. Selected values
      // keep their JSON types, so only text is comparable to a command.
      if (condition.witnessValues !== undefined) continue;
      for (const value of condition.matchedValues ?? [])
        if (typeof value === 'string') named.add(value);
      if (condition.matchedValue !== undefined)
        named.add(condition.matchedValue);
    }
  }
  return named;
}

export function coverageDetail(result: RuleTestResultView): CoverageDetail {
  const namedTexts = allowNamedTexts(result);
  const texts = (result.normalization?.commands ?? []).map(
    (command) => command.text,
  );
  const nodes: CoverageNode[] = [];
  for (const text of texts) {
    if (nodes.some((node) => node.text === text)) continue;
    nodes.push({ text, named: namedTexts.has(text) });
  }
  const structural = nodes.length > 0;
  return {
    nodes,
    total: nodes.length,
    namedCount: nodes.filter((node) => node.named).length,
    state: coverageState(finalPath(result), structural),
    structural,
  };
}

/**
 * Which coverage sentence the evaluator's own answer supports.
 *
 * `partial-allow` and `incomplete` are distinct on purpose: the first means the
 * allows that matched did not name every command, the second means the structure
 * itself was not fully read. Collapsing them would claim a command list for a
 * parse that never produced one.
 */
function coverageState(path: FinalPath, structural: boolean): CoverageState {
  if (path.kind === 'rule' && path.verdict === 'allow') return 'complete';
  if (path.kind === 'rule') return 'not-allow';
  if (path.reason === 'incomplete') return 'incomplete';
  if (path.reason === 'partial-allow')
    return structural ? 'partial' : 'no-structure';
  return 'not-allow';
}

/**
 * The fixed precedence, in the order the evaluator applies it.
 *
 * `review(default)` is the fallback path, not a verdict a rule can carry, so it
 * closes the list. Each level reports what it did for this call; nothing here is
 * derived from a pattern comparison, only from the evaluator's outcomes.
 */
export function priorityView(
  result: RuleTestResultView,
  focusedRuleId: string | null,
): readonly PriorityLevel[] {
  const path = finalPath(result);
  const order: (RuleVerdict | null)[] = [
    'deny',
    'force-ask',
    'force-review',
    'allow',
    null,
  ];
  return order.map((verdict) => {
    if (verdict === null) {
      const effective = path.kind === 'review';
      return {
        kind: 'fallback' as const,
        verdict: null,
        decision: effective ? ('effective' as const) : ('none' as const),
        ruleIds: [],
        focused: false,
      };
    }
    // A level matched when any rule at it matched, whether or not it decided.
    const matchedIds = result.rules
      .filter((entry) => entry.verdict === verdict && entry.outcome === 'match')
      .map((entry) => entry.id);
    const effective =
      path.kind === 'rule' &&
      path.verdict === verdict &&
      matchedIds.includes(path.ruleId);
    return {
      kind: 'rule' as const,
      verdict,
      decision: effective
        ? ('effective' as const)
        : matchedIds.length > 0
          ? ('matched' as const)
          : ('none' as const),
      ruleIds: matchedIds,
      focused:
        focusedRuleId !== null &&
        result.rules.some(
          (entry) =>
            entry.id === focusedRuleId &&
            entry.verdict === verdict &&
            entry.outcome !== 'unknown',
        ),
    };
  });
}

/**
 * A fingerprint of everything a result depends on.
 *
 * Results are compared against this instead of being cleared on edit: the old
 * answer stays readable but is marked as needing a new run, which is what the
 * contract asks for. The rules are part of the signature because the tester
 * evaluates the whole draft, not only the selected rule.
 */
export function testSignature(
  sample: TestSample,
  identity: SessionKind,
  rules: readonly DraftRule[],
  ruleId: string | null,
  cwd: string,
): string {
  return JSON.stringify([sample, identity, rules, ruleId, cwd]);
}

/**
 * A condition a rejected draft pointed at.
 *
 * `ruleId` and `conditionIndex` are resolved from the draft that produced the
 * error, not from the path string later: `rules[N]` is an index into the
 * submitted array, so after an edit it can name a different rule. Keeping the
 * stable id makes the action point at the rule it came from, and the path is
 * kept only for display.
 */
export interface IssueTarget {
  readonly path: string;
  readonly ruleId: string | null;
  readonly conditionIndex: number | null;
}

/** Resolve a `rules[N][.conditions[M]]` path against the draft that produced it. */
export function issueTarget(
  path: string,
  rules: readonly { readonly id: string }[],
): IssueTarget {
  const match = /^rules\[(\d+)\](?:\.conditions\[(\d+)\])?/u.exec(path);
  const ruleIndex = match?.[1] === undefined ? null : Number(match[1]);
  const conditionIndex = match?.[2] === undefined ? null : Number(match[2]);
  const rule = ruleIndex === null ? undefined : rules[ruleIndex];
  return {
    path,
    ruleId: rule?.id ?? null,
    conditionIndex,
  };
}

/** The tool a sample starts with: the selected rule's own scope, if any. */
export function defaultTool(rule: DraftRule | null): string {
  return rule?.scope?.tools?.[0] ?? 'bash';
}
