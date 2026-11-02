/** Fixed integer arithmetic and semantic vetoes; no production matrix participates. */
import type { WorkflowOpinion } from '../data/group-types.js';
import { knownModelIdentity } from '../data/annotation-model.js';
import type { BehaviourReference, ScorePair } from '../data/types.js';
import type { ModelIdentity } from '../data/types.js';
import { validEvidence } from './workflow-evidence.js';

export interface Consensus {
  readonly n: number;
  readonly k: number;
  readonly returned: number;
  readonly valid: number;
  readonly missing: number;
  readonly failed: number;
  readonly attempts: number;
  readonly branch: 'ratio' | 'n-minus-one' | 'both' | null;
  readonly maxDeviation: readonly [number, number] | null;
  readonly pair: ScorePair | null;
  readonly behaviour: BehaviourReference | null;
  readonly selectedOpinionIds: readonly string[];
  readonly supportingOpinionIds: readonly string[];
  readonly reasons: readonly string[];
  readonly participants: readonly {
    readonly modelKey: string;
    readonly selectedOpinionId: string | null;
    readonly attempts: readonly {
      readonly opinionId: string;
      readonly batchId: string;
      readonly model: ModelIdentity;
      readonly parameters: unknown;
      readonly outcome: WorkflowOpinion['outcome'];
    }[];
  }[];
}
export function modelConsensus(
  opinions: readonly WorkflowOpinion[],
  request?: unknown,
): Consensus {
  const complete = (value: WorkflowOpinion): boolean =>
    value.annotation?.complete === true &&
    value.annotation.rawResponse !== null &&
    value.annotation.pairs !== null &&
    value.annotation.problems.length === 0 &&
    value.independentBehaviour !== null &&
    (value.rationale?.trim().length ?? 0) > 0 &&
    value.evidence.every((item) => item.kind === 'material-quote') &&
    validEvidence(
      value.evidence.map((item) => item.ref),
      request,
      true,
    );
  const identities = new Map<string, string>();
  const root = (key: string): string => {
    const parent = identities.get(key);
    if (parent === undefined) {
      identities.set(key, key);
      return key;
    }
    return parent === key ? key : root(parent);
  };
  const unite = (left: string, right: string): void => {
    const a = root(left),
      b = root(right);
    if (a !== b) identities.set(a < b ? b : a, a < b ? a : b);
  };
  const known = new Map<string, string>();
  for (const value of opinions) {
    const annotation = value.annotation;
    if (annotation === undefined) continue;
    for (const alias of annotation.aliases) unite(alias, annotation.modelKey);
    const identity = knownModelIdentity(value.opinion.model);
    if (identity !== null) {
      const previous = known.get(identity);
      if (previous !== undefined) unite(previous, annotation.modelKey);
      else known.set(identity, annotation.modelKey);
    }
  }
  const groups = new Map<string, WorkflowOpinion[]>();
  for (const value of opinions) {
    if (value.annotation === undefined) continue;
    const key = root(value.annotation.modelKey);
    const group = groups.get(key) ?? [];
    group.push(value);
    groups.set(key, group);
  }
  const selected = [...groups.values()].map((group) =>
    [...group]
      .sort(
        (a, b) =>
          (a.annotation?.recordedOrder ?? 0) -
            (b.annotation?.recordedOrder ?? 0) ||
          a.opinion.reviewId.localeCompare(b.opinion.reviewId),
      )
      .find(complete),
  );
  const votes = selected.filter((value) => value !== undefined);
  const counts = new Map<string, WorkflowOpinion[]>();
  for (const vote of votes) {
    const pairs = vote.annotation?.pairs;
    if (pairs?.length !== 1) continue;
    const key = JSON.stringify(pairs[0]);
    const supporters = counts.get(key) ?? [];
    supporters.push(vote);
    counts.set(key, supporters);
  }
  const majority =
    [...counts.values()].sort((a, b) => b.length - a.length)[0] ?? [];
  const candidate = majority[0]?.annotation?.pairs?.[0] ?? null;
  const n = groups.size,
    k = majority.length;
  const ratio = 100 * k >= 80 * n,
    nearlyAll = k >= n - 1;
  const reasons: string[] = [];
  if (n < 3 || k < 3 || !(ratio || nearlyAll))
    reasons.push('insufficient-exact-pair-consensus');
  if (votes.length !== n) reasons.push('incomplete-opinions');
  if (votes.some((value) => value.annotation?.pairs?.length !== 1))
    reasons.push('multiple-reasonable-pairs');
  if (opinions.some((value) => (value.annotation?.conflicts.length ?? 0) > 0))
    reasons.push('key-evidence-conflict');
  const behaviours = new Set(votes.map((value) => value.independentBehaviour));
  if (behaviours.size !== 1 || behaviours.has(null))
    reasons.push('behaviour-disagreement');
  const authorizations = votes.flatMap(
    (value) => value.annotation?.pairs?.map((pair) => pair[1]) ?? [],
  );
  if (authorizations.includes(1) && authorizations.some((value) => value !== 1))
    reasons.push('a1-boundary');
  let riskDeviation = 0,
    authorizationDeviation = 0;
  for (const vote of votes)
    for (const pair of vote.annotation?.pairs ?? []) {
      if (candidate === null) continue;
      riskDeviation = Math.max(riskDeviation, Math.abs(pair[0] - candidate[0]));
      authorizationDeviation = Math.max(
        authorizationDeviation,
        Math.abs(pair[1] - candidate[1]),
      );
    }
  if (riskDeviation > 1 || authorizationDeviation > 1)
    reasons.push('score-deviation');
  return {
    n,
    k,
    returned: [...groups.values()].filter((group) =>
      group.some(
        (value) =>
          value.annotation?.rawResponse !== null &&
          value.annotation?.rawResponse !== undefined,
      ),
    ).length,
    valid: votes.length,
    missing: [...groups.values()].filter((group) =>
      group.every((value) => value.outcome === 'missing'),
    ).length,
    failed: [...groups.values()].filter(
      (group) =>
        !group.some(complete) &&
        group.some((value) => value.outcome === 'failed'),
    ).length,
    attempts: opinions.filter((value) => !value.annotation?.registration)
      .length,
    branch:
      reasons.length === 0 && k >= 3 && (ratio || nearlyAll)
        ? ratio && nearlyAll
          ? 'both'
          : ratio
            ? 'ratio'
            : 'n-minus-one'
        : null,
    maxDeviation:
      candidate === null ? null : [riskDeviation, authorizationDeviation],
    pair: reasons.length === 0 ? candidate : null,
    behaviour:
      reasons.length === 0 ? (votes[0]?.independentBehaviour ?? null) : null,
    selectedOpinionIds: votes.map((value) => value.opinion.reviewId),
    supportingOpinionIds: majority.map((value) => value.opinion.reviewId),
    reasons,
    participants: [...groups.entries()].map(([modelKey, group]) => ({
      modelKey,
      selectedOpinionId:
        selected.find((value) => value !== undefined && group.includes(value))
          ?.opinion.reviewId ?? null,
      attempts: group.map((value) => ({
        opinionId: value.opinion.reviewId,
        batchId: value.batchId,
        model: value.opinion.model,
        parameters: value.annotation?.parameters ?? null,
        outcome: value.outcome,
      })),
    })),
  };
}
