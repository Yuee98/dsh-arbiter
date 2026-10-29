/**
 * What a valid experiment definition has to satisfy beyond its schema.
 *
 * A JSON Schema can say a candidate has four axes; it cannot say that the ladder is a
 * ladder, that candidate A *is* production's package, or that the frozen probe text is
 * the one the reviewer actually asks. These checks are the ones that make the
 * definition mean what it claims:
 *
 *   - every candidate is a real package of the variant vocabulary and its id is the
 *     derived one, so two candidates cannot name one package;
 *   - one candidate is the production package, unchanged. That is the design's
 *     candidate A and it is what makes "the experiment did not change the default" a
 *     checkable property instead of a promise: the baseline is production itself, not a
 *     re-implementation of it;
 *   - each ladder step changes exactly the one axis it says it changes, relative to a
 *     reference that exists, so a difference in results has one candidate explanation;
 *   - the probe definition is the code's own version, member and option set, and it
 *     fixes `unknown` as the one legal "the material does not establish this" answer;
 *   - the budget is internally satisfiable, and the cache workload contains a cold
 *     request and a re-use.
 *
 * Nothing here decides an answer, reads a case or calls a model.
 */

import {
  PROBE_MEMBER,
  PROBE_OPTIONS,
  REVIEW_PROBE_VERSION,
} from '../../../src/reviewer/probe.js';
import {
  defineVariant,
  PRODUCTION_VARIANT,
  variantDiff,
  variantIdFor,
} from '../../../src/reviewer/variant.js';
import type { ReviewVariant } from '../../../src/reviewer/variant.js';

import type {
  CandidateDefinition,
  ExperimentDefinition,
  LadderStep,
} from './types.js';

/** One candidate resolved into the variant the reviewer would render. */
export interface ResolvedCandidate {
  readonly candidateId: string;
  readonly label: string;
  readonly variant: ReviewVariant;
}

/** Every candidate, resolved from its axes. */
export function resolveCandidates(
  definition: ExperimentDefinition,
): readonly ResolvedCandidate[] {
  return definition.candidates.map((candidate) => ({
    candidateId: candidate.candidateId,
    label: candidate.label,
    variant: defineVariant(candidate.axes),
  }));
}

/** The problems a definition has beyond its schema. */
export function definitionProblems(
  definition: ExperimentDefinition,
): readonly string[] {
  return [
    ...candidateProblems(definition),
    ...ladderProblems(definition),
    ...probeProblems(definition),
    ...budgetProblems(definition),
  ];
}

/** Every candidate must be a distinct package, and one of them is production. */
function candidateProblems(
  definition: ExperimentDefinition,
): readonly string[] {
  const problems: string[] = [];
  const seenIds = new Set<string>();
  const seenVariants = new Set<string>();
  for (const candidate of definition.candidates) {
    if (seenIds.has(candidate.candidateId)) {
      problems.push(`candidate ${candidate.candidateId} is declared twice`);
    }
    seenIds.add(candidate.candidateId);
    const variant = defineVariant(candidate.axes);
    // Unreachable through `defineVariant`; kept because the id is a stored value and a
    // hand-written document could carry one that names no package.
    if (variant.variantId !== variantIdFor(candidate.axes)) {
      problems.push(
        `candidate ${candidate.candidateId} names variant ${variant.variantId}, which is not its axes`,
      );
    }
    if (seenVariants.has(variant.variantId)) {
      problems.push(
        `candidate ${candidate.candidateId} duplicates package ${variant.variantId}; two candidates cannot measure one package`,
      );
    }
    seenVariants.add(variant.variantId);
  }
  if (!seenVariants.has(PRODUCTION_VARIANT.variantId)) {
    // The baseline has to be production's own package. A candidate that merely looks
    // like it would make every difference uninterpretable: a result could have moved
    // because of the treatment or because the baseline was a re-implementation.
    problems.push(
      `no candidate is the production package (${PRODUCTION_VARIANT.variantId}); every comparison needs production's own package as its baseline`,
    );
  }
  const probeCandidates = definition.candidates.filter(
    (candidate) => candidate.axes.prompt === 'recovery-probe',
  );
  if (probeCandidates.length === 0) {
    // The A/B comparison is the experiment; a matrix with no B measures nothing about
    // the probe. Reporting it is the difference between an ablation and a wish.
    problems.push(
      'no candidate asks the recovery probe; the A/B comparison needs at least one candidate with prompt recovery-probe',
    );
  }
  return problems;
}

/** Every ladder step must change exactly one axis from something that exists. */
function ladderProblems(definition: ExperimentDefinition): readonly string[] {
  const problems: string[] = [];
  const candidates = new Map<string, CandidateDefinition>(
    definition.candidates.map((entry) => [entry.candidateId, entry]),
  );
  const steps = new Map<string, LadderStep>();
  const seen = new Set<string>();
  for (const step of definition.ladder) {
    if (seen.has(step.stepId)) {
      problems.push(`ladder step ${step.stepId} is declared twice`);
    }
    seen.add(step.stepId);
    const reference =
      candidates.get(step.from)?.axes ?? steps.get(step.from)?.axes ?? null;
    if (reference === null) {
      problems.push(
        `ladder step ${step.stepId} builds on ${step.from}, which is neither a candidate nor an earlier step`,
      );
      steps.set(step.stepId, step);
      continue;
    }
    if (step.changes.length !== 1) {
      problems.push(
        `ladder step ${step.stepId} declares ${String(step.changes.length)} changed axes; an ablation step changes exactly one`,
      );
    }
    const actual = variantDiff(
      defineVariant(reference),
      defineVariant(step.axes),
    );
    const declared = [...step.changes].sort();
    if (
      actual.length !== declared.length ||
      actual.some((axis, index) => axis !== declared[index])
    ) {
      problems.push(
        `ladder step ${step.stepId} declares ${step.changes.join('+')} but actually changes ${actual.length === 0 ? 'nothing' : actual.join('+')}`,
      );
    }
    steps.set(step.stepId, step);
  }
  return problems;
}

/** The probe definition must be the code's own, including its unknown answer. */
function probeProblems(definition: ExperimentDefinition): readonly string[] {
  const problems: string[] = [];
  const probe = definition.probe;
  if (probe.version !== REVIEW_PROBE_VERSION) {
    problems.push(
      `experiment probe version ${probe.version} is not the reviewer's ${REVIEW_PROBE_VERSION}`,
    );
  }
  if (probe.member !== PROBE_MEMBER) {
    problems.push(
      `experiment probe member ${probe.member} is not the reviewer's ${PROBE_MEMBER}`,
    );
  }
  const expected = [...PROBE_OPTIONS];
  const actual = [...probe.options];
  if (
    expected.length !== actual.length ||
    expected.some((option, index) => option !== actual[index])
  ) {
    problems.push(
      `experiment probe options ${actual.join(',')} are not the reviewer's ${expected.join(',')}`,
    );
  }
  if (probe.unknown !== 'unknown') {
    problems.push(
      `experiment probe must fix "unknown" as its unestablished answer, not ${probe.unknown}`,
    );
  }
  for (const option of [
    'withdrawn',
    'recoverable',
    'partially-recoverable',
    'irreversible',
  ]) {
    if (!probe.options.includes(option)) {
      problems.push(
        `the probe does not distinguish ${option}; withdrawal, recovery and residual damage have to be separable answers`,
      );
    }
  }
  if (!/never change|does not change|same risk/iu.test(probe.bandRule)) {
    problems.push(
      'the probe band rule does not state that the probe never changes a band, which the design fixes',
    );
  }
  if (!/withdraw/iu.test(probe.withdrawnRule)) {
    problems.push(
      'the probe withdrawn rule does not name withdrawal; the design separates withdrawal from recovery',
    );
  }
  return problems;
}

/**
 * The budget must be satisfiable by the matrix it describes.
 *
 * The request ceiling is compared against the matrix's own lower bound here, before any
 * provider is chosen, because a plan that cannot fit its own repeats is a plan that
 * would stop halfway and call that a boundary. The cache workload is checked the same
 * way and from the definition alone: its slots have to name the actions they submit, so
 * raising a slot's repeats cannot quietly reuse one.
 */
function budgetProblems(definition: ExperimentDefinition): readonly string[] {
  const problems: string[] = [];
  const budget = definition.budget;
  if (budget.maxRepairRetries > definition.bounds.maxAttempts) {
    problems.push(
      `budget maxRepairRetries ${String(budget.maxRepairRetries)} exceeds the run's maxAttempts ${String(definition.bounds.maxAttempts)}`,
    );
  }
  // One request per cell at minimum: cases are at least one, so repeats x protocols x
  // candidates is a lower bound the ceiling has to cover.
  const minimum =
    definition.repeats *
    definition.protocols.length *
    definition.candidates.length;
  if (budget.maxRequests < minimum) {
    problems.push(
      `budget maxRequests ${String(budget.maxRequests)} cannot cover the matrix's ${String(minimum)} minimum cell(s)`,
    );
  }
  problems.push(...cacheSlotProblems(definition));
  return problems;
}

/**
 * Why the cache sequence cannot be expanded into the workload it names.
 *
 * All of this is decidable without a case, so it is reported at load rather than left to
 * the expansion: a cold request, a re-use, and enough named actions for the slots that
 * need them.
 */
function cacheSlotProblems(
  definition: ExperimentDefinition,
): readonly string[] {
  const problems: string[] = [];
  const { sequence, changedActionCaseIds, baseCaseId } = definition.cache;
  if (!sequence.some((slot) => slot.role === 'cold')) {
    problems.push(
      'the cache workload names no cold request; a warm-only sequence cannot show what the cache did',
    );
  }
  if (!sequence.some((slot) => slot.role !== 'cold')) {
    problems.push(
      'the cache workload names only cold requests; nothing would be re-used',
    );
  }
  if (sequence.reduce((sum, slot) => sum + slot.repeats, 0) < 2) {
    problems.push(
      'the cache workload needs at least a cold request and one re-use to measure anything',
    );
  }
  const cold = sequence.filter((slot) => slot.role === 'cold');
  if (cold.length > 1) {
    problems.push(
      `the cache workload names ${String(cold.length)} cold request(s); a workload with more than one has no single prefix to re-use`,
    );
  }
  if (changedActionCaseIds.includes(baseCaseId)) {
    problems.push(
      `the cache workload names ${baseCaseId} as both its base case and a changed action, so the change would be invisible in the action region`,
    );
  }
  const unique = new Set(changedActionCaseIds);
  if (unique.size !== changedActionCaseIds.length) {
    problems.push(
      'the cache workload declares the same changed action more than once; two slots submitting one action cannot show that a change was made',
    );
  }
  const asked = sequence
    .filter((slot) => slot.role === 'changed-action')
    .reduce((sum, slot) => sum + slot.repeats, 0);
  if (asked > changedActionCaseIds.length) {
    problems.push(
      `the cache workload asks for ${String(asked)} changed action(s) but declares ${String(changedActionCaseIds.length)}; a slot's repeats add real requests and need real actions`,
    );
  }
  return problems;
}

/** The lower-bound cell count of one candidate, from the definition alone. */
export function minimumCells(definition: ExperimentDefinition): number {
  return definition.repeats * definition.protocols.length;
}
