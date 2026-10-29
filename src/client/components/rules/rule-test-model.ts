/**
 * Rule-tester view logic.
 *
 * The tester explains what the shared evaluator answered; it never re-derives a
 * match. Everything here reads a decoded `/api/arbiter/test` answer and decides
 * which sentence applies, which rule the answer is about, and when a result has
 * gone stale. Keeping that pure lets the React layer stay a rendering layer and
 * lets Node tests cover the explanation contract.
 */

import { VERDICT_ORDER } from './draft.js';
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
 *
 * There is deliberately no "wrong shape" problem. A recorded call's arguments are
 * `unknown` all the way to the evaluator, so an array, a string or a number is a
 * real input a rule may have judged; refusing it here would make a recorded call
 * unreplayable in the tester that is supposed to answer for it.
 */
export type SampleProblem =
  | { readonly kind: 'tool-required' }
  | { readonly kind: 'command-required' }
  | { readonly kind: 'json-syntax'; readonly message: string };

export type SampleBuild =
  | { readonly ok: true; readonly sample: TestSample }
  | { readonly ok: false; readonly problem: SampleProblem };

/**
 * Turn the typed sample into the call the evaluator sees.
 *
 * Command text is passed through unchanged: normalizing it is the shell
 * reader's job (#8), and doing it here would give the tester a different command
 * from the gate's. Argument JSON is parsed so a syntax error is located at the
 * input rather than becoming a non-match; any value JSON can express is accepted,
 * because that is what the gate and the evaluator accept.
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
  /**
   * Matches a decisive higher-priority rule actually beat.
   *
   * Only a rule that ended the call can outrank another one. A matched `allow`
   * under `review(default)` was not outranked by anything — that path is decided
   * by no rule — and allow coverage accumulates across rules, so neither case may
   * be reported as "did not take effect".
   */
  readonly shadowed: readonly RuleMatchDetail[];
  /**
   * Other `allow` matches that no decisive rule displaced.
   *
   * This covers both a credited `allow` and a `review(default)` fallback where the
   * allows were collectively insufficient. Neither "shadowed" nor "contributed"
   * is established for them: the evaluator does not publish which rule supplied
   * which part of the coverage. The panel therefore reports that they matched at
   * the same priority and states the accumulation rule, instead of claiming
   * either effect on the result.
   */
  readonly additionalAllows: readonly RuleMatchDetail[];
  readonly unknown: readonly string[];
  readonly reviewReason: ReviewReason | null;
  readonly allowMatched: boolean;
}

export function coverageView(result: RuleTestResultView): CoverageView {
  const path = finalPath(result);
  const secondary = result.matches.filter((match) => !match.effective);
  /**
   * True only when a decisive higher-priority rule is what ended the call.
   *
   * A `review(default)` path was decided by no rule at all, so nothing outranked
   * a matched `allow` there: the allows simply did not accumulate enough
   * coverage. Calling that "did not take effect" would blame priority for a
   * coverage outcome. An `allow` path is excluded too, because allow coverage
   * accumulates across rules.
   */
  const allowWasOutranked = path.kind === 'rule' && path.verdict !== 'allow';
  const isAlsoMatchedAllow = (match: RuleMatchDetail): boolean =>
    match.verdict === 'allow' && !allowWasOutranked;
  return {
    shadowed: secondary.filter((match) => !isAlsoMatchedAllow(match)),
    additionalAllows: secondary.filter(isAlsoMatchedAllow),
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
 * What one precedence level contributed to this call.
 *
 * These are deliberately distinct. Only one of them means "a higher-priority
 * rule beat this one": an `allow` that matched but was not credited with the
 * whole call was not outranked by anything, and a rule that could not be
 * determined was never proven to be a non-match. Collapsing them into one label
 * would contradict the evaluator's own answer.
 */
export type PriorityDecision =
  /** The rule the evaluator's final path names. */
  | 'effective'
  /** Another rule at the winning tier also matched; configuration order picked the winner. */
  | 'tier-match'
  /** Matched and was beaten by a decisive higher-priority rule. */
  | 'shadowed'
  /** Matched, but the call still went to review because its coverage was insufficient. */
  | 'insufficient-coverage'
  /**
   * Matched, but a higher-priority rule could not be determined, so the allow
   * was withheld. This is not the same as the allow itself being unknown.
   */
  | 'withheld-by-unknown'
  /** Could not be determined, so it never became a match or a non-match. */
  | 'unknown'
  /** Took no part in this answer. */
  | 'none';

/** One level of the fixed whole-config precedence, as this answer used it. */
export interface PriorityLevel {
  readonly kind: 'rule' | 'fallback';
  readonly verdict: RuleVerdict | null;
  readonly decision: PriorityDecision;
  /** The single rule the final path credits, when this level produced it. */
  readonly winnerId: string | null;
  /** Other rules at this level that matched without being the credited one. */
  readonly otherIds: readonly string[];
  /** Rules at this level whose outcome could not be determined. */
  readonly unknownIds: readonly string[];
  /** True when the focused rule sits at this level and took part. */
  readonly focused: boolean;
}

/** One command occurrence the parse published, in parse order. */
export interface CoverageNode {
  /** Position in the parse, so two identical commands stay distinct. */
  readonly index: number;
  readonly text: string;
  /** True when an `allow` *command* condition named this occurrence's text. */
  readonly named: boolean;
}

/**
 * How the evaluator classified coverage, taken from its own path.
 *
 * This is deliberately not re-derived: `matches[].effective` is set before the
 * final path is chosen, so a matched `allow` can carry `effective: true` while
 * the call actually went to `review(default)` because it did not cover
 * everything. Only `pathDetail` says what coverage was credited.
 */
export type CoverageState =
  | 'complete'
  | 'partial'
  | 'incomplete'
  | 'not-allow'
  | 'unresolved'
  | 'unknown-structure';

/**
 * What the call offered, and what the evaluator credited an `allow` with.
 *
 * A composite command is the case the contract calls out: allowing `gh pr view`
 * says nothing about the `rm` after `&&`. Command occurrences are evidence of
 * what an `allow` *command* condition named; they never compute the
 * classification, which comes from `pathDetail`.
 *
 * An uncovered structural effect need not be a command: a redirect or an
 * assignment is a separate target that a command match cannot authorize. The
 * panel therefore reports `otherTargets` alongside the command list instead of
 * blaming the fallback on unnamed commands.
 */
export interface CoverageDetail {
  readonly nodes: readonly CoverageNode[];
  readonly total: number;
  readonly namedCount: number;
  readonly state: CoverageState;
  /** True when the parse published at least one command occurrence. */
  readonly structural: boolean;
  /**
   * Structural node kinds the parse published beyond plain commands, such as a
   * redirect or an assignment. Coverage of these is not visible from commands.
   */
  readonly otherTargets: readonly ('file_redirect' | 'variable_assignment')[];
  /** False when the tester has no per-command evidence at all. */
  readonly hasEvidence: boolean;
  /**
   * True when the evaluator read this call's structure without failing.
   *
   * Independent of {@link structural}: a successful parse can publish redirects
   * and assignments only, and a *failed* parse publishes nothing at all. Only the
   * former may be described as "parsed".
   */
  readonly parsed: boolean;
}

/**
 * The command texts an `allow` condition named.
 *
 * Only `command`-target conditions count. A matching `argument` condition names
 * a selected value, and on a shell call that value covers no structural node, so
 * attributing it to a command would report coverage the evaluator did not grant.
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
      if (condition.target !== 'command') continue;
      // `witnessValues` is authoritative for an `all` conjunction: a condition
      // that matched a node no sibling matched does not cover it.
      const witnesses = condition.witnessValues;
      if (witnesses !== undefined) {
        for (const text of witnesses) named.add(text);
        continue;
      }
      // One condition can match several commands (`echo a; echo b` against
      // `echo .*`). Every text it matched counts, not just the first.
      for (const value of condition.matchedValues ?? [])
        if (typeof value === 'string') named.add(value);
      if (condition.matchedValue !== undefined)
        named.add(condition.matchedValue);
    }
  }
  return named;
}

/** Structural kinds that a command match alone cannot authorize. */
function otherStructuralTargets(
  result: RuleTestResultView,
): readonly ('file_redirect' | 'variable_assignment')[] {
  const kinds: ('file_redirect' | 'variable_assignment')[] = [];
  if (result.parse.nodes.includes('file_redirect')) kinds.push('file_redirect');
  if (result.parse.nodes.includes('variable_assignment'))
    kinds.push('variable_assignment');
  return kinds;
}

export function coverageDetail(result: RuleTestResultView): CoverageDetail {
  const namedTexts = allowNamedTexts(result);
  // Every occurrence is kept: `echo hi; echo hi` ran twice, and collapsing the
  // two into one entry would hide an operation the parser observed.
  const commands = result.normalization?.commands ?? [];
  const nodes: CoverageNode[] = commands.map((command, index) => ({
    index,
    text: command.text,
    named: namedTexts.has(command.text),
  }));
  const hasEvidence =
    result.normalization !== null && result.normalization !== undefined;
  // A successful parse can publish redirects and assignments only, which is
  // structure without a command. A *failed* parse publishes nothing and must not
  // be described as a successful read, so the two are recorded separately.
  const parsed = result.parse.status === 'ok';
  return {
    nodes,
    total: nodes.length,
    namedCount: nodes.filter((node) => node.named).length,
    state: coverageState(finalPath(result), hasEvidence),
    structural: nodes.length > 0,
    otherTargets: otherStructuralTargets(result),
    hasEvidence,
    parsed,
  };
}

/**
 * Which coverage sentence the evaluator's own answer supports.
 *
 * `partial`, `incomplete` and `unresolved` are distinct causes and stay distinct:
 * insufficient coverage, a structure that was never fully read, and an
 * undetermined higher-priority rule. Reporting any of them as the others would
 * state a reason the evaluator did not give.
 */
function coverageState(path: FinalPath, hasEvidence: boolean): CoverageState {
  if (path.kind === 'rule') {
    return path.verdict === 'allow' ? 'complete' : 'not-allow';
  }
  switch (path.reason) {
    case 'partial-allow':
      return hasEvidence ? 'partial' : 'unknown-structure';
    case 'incomplete':
      return 'incomplete';
    case 'unresolved':
      return 'unresolved';
    case 'no-match':
      return 'not-allow';
  }
}

/**
 * The fixed precedence, in the order the evaluator applies it.
 *
 * `review(default)` is the fallback path, not a verdict a rule can carry, so it
 * closes the list. Each level reports what it did for this call; nothing here is
 * derived from a pattern comparison, only from the evaluator's outcomes and its
 * final path.
 */
export function priorityView(
  result: RuleTestResultView,
  focusedRuleId: string | null,
): readonly PriorityLevel[] {
  const path = finalPath(result);
  return PRIORITY_VERDICTS.map((verdict) =>
    verdict === null
      ? fallbackLevel(path)
      : ruleLevel(result, verdict, path, focusedRuleId),
  );
}

/** The precedence order, reusing the constant the editor already declares. */
const PRIORITY_VERDICTS: readonly (RuleVerdict | null)[] = [
  ...VERDICT_ORDER,
  null,
];

function fallbackLevel(path: FinalPath): PriorityLevel {
  const effective = path.kind === 'review';
  return {
    kind: 'fallback',
    verdict: null,
    decision: effective ? 'effective' : 'none',
    winnerId: null,
    otherIds: [],
    unknownIds: [],
    focused: false,
  };
}

/** Why a matched `allow` still sent the call to review. */
function allowNotApplied(
  path: FinalPath,
): 'insufficient-coverage' | 'withheld-by-unknown' | 'shadowed' | 'none' {
  if (path.kind === 'rule') return 'shadowed';
  switch (path.reason) {
    case 'partial-allow':
    case 'incomplete':
      return 'insufficient-coverage';
    // The allow itself matched; an undetermined higher-priority rule is what
    // kept it from deciding, so this is not the allow's own outcome.
    case 'unresolved':
      return 'withheld-by-unknown';
    case 'no-match':
      return 'none';
  }
}

function ruleLevel(
  result: RuleTestResultView,
  verdict: RuleVerdict,
  path: FinalPath,
  focusedRuleId: string | null,
): PriorityLevel {
  const matchedIds = result.rules
    .filter((entry) => entry.verdict === verdict && entry.outcome === 'match')
    .map((entry) => entry.id);
  const unknownIds = result.rules
    .filter((entry) => entry.verdict === verdict && entry.outcome === 'unknown')
    .map((entry) => entry.id);
  const winnerId =
    path.kind === 'rule' &&
    path.verdict === verdict &&
    matchedIds.includes(path.ruleId)
      ? path.ruleId
      : null;
  return {
    kind: 'rule',
    verdict,
    decision: ruleDecision(verdict, matchedIds, unknownIds, winnerId, path),
    winnerId,
    otherIds: matchedIds.filter((id) => id !== winnerId),
    unknownIds,
    // The marker says where the selected rule sits, not how it turned out:
    // dropping it on a non-match would hide the tier exactly when the reader is
    // asking why their rule did not apply.
    focused:
      focusedRuleId !== null &&
      result.rules.some(
        (entry) => entry.id === focusedRuleId && entry.verdict === verdict,
      ),
  };
}

/**
 * One level's contribution.
 *
 * A winner is the only `effective`. Another match at the winning tier is
 * `tier-match`, because configuration order picked one of them. A match anywhere
 * else was either outranked by a decisive rule or left the call in review, and
 * those two are not the same finding.
 */
function ruleDecision(
  verdict: RuleVerdict,
  matchedIds: readonly string[],
  unknownIds: readonly string[],
  winnerId: string | null,
  path: FinalPath,
): PriorityDecision {
  // The credited rule is the only `effective`; its tier siblings are not.
  if (winnerId !== null)
    return matchedIds.length > 1 ? 'tier-match' : 'effective';
  if (path.kind === 'rule') {
    // A decisive verdict exists, so any other match lost on priority. A tier with
    // no match can still hold an undetermined rule: the decisive rule is what
    // ended the call, but that tier was never shown to be a non-match, and the
    // panel's own undetermined list names it. Reporting it as "no match this time"
    // would contradict both the evaluator and that list.
    if (matchedIds.length > 0) return 'shadowed';
    return unknownIds.length > 0 ? 'unknown' : 'none';
  }
  if (matchedIds.length > 0) {
    return verdict === 'allow' ? allowNotApplied(path) : 'none';
  }
  // An undetermined rule is neither a match nor a non-match.
  if (unknownIds.length > 0) return 'unknown';
  return 'none';
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
