/**
 * How one rule combines its own conditions.
 *
 * `any` keeps the historical meaning: one certain match decides. `all` requires
 * every condition to hold, and for the structural targets one node must satisfy
 * all of them — checking them independently would let a rule pair a command from
 * one statement with a redirect from another and call the pair allowed.
 *
 * Split from the compiler because the predicate is where the safety of `all`
 * lives, and it deserves to be read on its own.
 */

import type {
  CommandRule,
  RuleCombine,
  RuleConditionOutcome,
  RuleConditionResult,
  RuleConjunctionGroup,
  RuleTarget,
} from '../types.js';
import type { CallSubjects, CompiledCondition } from './compile.js';

/**
 * How a rule combines its conditions, including the canonicalization of a
 * document that never stated it.
 *
 * A rule with several conditions and no `combine` is a v1/v2 rule and meant the
 * alternative reading; defaulting it to `all` would narrow a saved `deny` into
 * near-uselessness and a saved `allow` into something the author never approved.
 * Parsers reject the absence for a v3 document, so this default only covers
 * rules built in code and legacy documents.
 */
export function combineOf(rule: CommandRule): RuleCombine {
  if (rule.combine !== undefined) return rule.combine;
  return rule.conditions.length > 1 ? 'any' : 'all';
}

/** The conditions of one rule that share a target, in rule order. */
interface TargetGroup {
  readonly target: RuleTarget;
  readonly members: readonly {
    readonly compiled: CompiledCondition;
    readonly index: number;
  }[];
}

function groupByTarget(
  conditions: readonly CompiledCondition[],
): readonly TargetGroup[] {
  const order: RuleTarget[] = [];
  const members = new Map<
    RuleTarget,
    { compiled: CompiledCondition; index: number }[]
  >();
  conditions.forEach((compiled, index) => {
    const target = compiled.condition.target;
    const bucket = members.get(target);
    if (bucket === undefined) {
      order.push(target);
      members.set(target, [{ compiled, index }]);
    } else bucket.push({ compiled, index });
  });
  return order.map((target) => ({
    target,
    members: members.get(target) ?? [],
  }));
}

/**
 * Resolve one structural group by finding a node that satisfies every condition.
 *
 * This is the safety core of `all`. Checking the conditions independently would
 * let `[command glob "git *", command regex ".*--force"]` match
 * `git status && rm --force` by pairing one condition with one node and the
 * other with another; coverage would then call both nodes allowed. Requiring one
 * witness node turns that into a plain non-match.
 */
function evaluateStructuralGroup(
  group: TargetGroup,
  call: CallSubjects,
): {
  readonly outcome: RuleConditionOutcome;
  readonly witnessTexts?: readonly string[];
} {
  const candidates = call.subjects.filter(
    (subject) => subject.target === group.target,
  );
  const known = candidates.filter((subject) => !subject.unresolved);
  const witnesses = known.filter((subject) =>
    group.members.every((member) => member.compiled.matches(subject.text)),
  );
  // Every node that satisfies the whole group is a witness, not just the first:
  // a single condition can match several commands (a regex over a compound line,
  // or a case-insensitive exact value), and each of those nodes is covered.
  if (witnesses.length > 0)
    return {
      outcome: 'match',
      witnessTexts: witnesses.map((witness) => witness.text),
    };
  // Nothing in the observed structure satisfies all of them. Whether that is a
  // certain miss depends on whether any structure went unread: a node nobody
  // looked at, or an unresolved target, could still be the witness.
  const partiallyRead = call.shellCall && !call.structureComplete;
  if (candidates.some((subject) => subject.unresolved) || partiallyRead)
    return { outcome: 'unknown' };
  return { outcome: 'no-match' };
}

/** The group's witness text, when the group matched a node. */
function witnessField(texts: readonly string[] | undefined): {
  readonly witnessText?: string;
} {
  const first = texts?.[0];
  return first === undefined ? {} : { witnessText: first };
}

/** Resolve a `tool` or `argument` group: one value object, so conjunction is plain. */
function evaluateValueGroup(
  group: TargetGroup,
  results: readonly RuleConditionResult[],
): RuleConditionOutcome {
  const outcomes = group.members.map(
    (member) => results[member.index]?.outcome ?? 'no-match',
  );
  if (outcomes.every((outcome) => outcome === 'match')) return 'match';
  if (outcomes.some((outcome) => outcome === 'no-match')) return 'no-match';
  return 'unknown';
}

/**
 * Apply `all` to the per-condition results.
 *
 * A group matches only when a single node satisfies every condition in it (for
 * structural targets) or when every condition matches (for the single-value
 * targets). The rule then matches when every group matches. A group that
 * certainly cannot be satisfied decides the rule even if another group is
 * unknown, because a conjunction with a false conjunct is false.
 */
export function combineAll(
  conditions: readonly CompiledCondition[],
  results: readonly RuleConditionResult[],
  call: CallSubjects,
): {
  readonly outcome: RuleConditionOutcome;
  readonly conditions: readonly RuleConditionResult[];
  readonly groups: readonly RuleConjunctionGroup[];
} {
  const resolved = groupByTarget(conditions).map((group) => {
    if (group.target === 'tool' || group.target === 'argument')
      return {
        group,
        outcome: evaluateValueGroup(group, results),
        valueWitnesses: group.members.flatMap((member) => {
          const text = results[member.index]?.matchedValue;
          return text === undefined
            ? []
            : [{ conditionIndex: member.index, text }];
        }),
      };
    return { group, ...evaluateStructuralGroup(group, call) };
  });
  const outcome: RuleConditionOutcome = resolved.every(
    (entry) => entry.outcome === 'match',
  )
    ? 'match'
    : resolved.some((entry) => entry.outcome === 'no-match')
      ? 'no-match'
      : 'unknown';
  // Only a group witness may contribute coverage. A condition that matched a node
  // no sibling matched covers nothing, which is what keeps the pair of unrelated
  // statements from being read as one allowed operation.
  const witnessByCondition = new Map<number, readonly string[]>();
  for (const entry of resolved) {
    if (entry.outcome !== 'match') continue;
    for (const member of entry.group.members) {
      if (entry.group.target === 'tool' || entry.group.target === 'argument')
        continue;
      const texts = 'witnessTexts' in entry ? entry.witnessTexts : undefined;
      if (texts !== undefined) witnessByCondition.set(member.index, texts);
    }
  }
  const annotated = results.map((result) => {
    const witness = witnessByCondition.get(result.index);
    return witness === undefined
      ? result
      : { ...result, witnessValues: witness };
  });
  return {
    outcome,
    conditions: annotated,
    groups: resolved.map((entry) => ({
      target: entry.group.target,
      conditionIndices: entry.group.members.map((member) => member.index),
      outcome: entry.outcome,
      ...witnessField('witnessTexts' in entry ? entry.witnessTexts : undefined),
      // A value group has no node text, so its own matched values are the only
      // evidence history can show for that conjunct.
      ...('valueWitnesses' in entry && entry.valueWitnesses.length > 0
        ? { witnessValues: entry.valueWitnesses }
        : {}),
    })),
  };
}
