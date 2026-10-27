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
