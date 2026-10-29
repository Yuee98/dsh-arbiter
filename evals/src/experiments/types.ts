/**
 * The experiment definition's TypeScript shape.
 *
 * One document describes a whole candidate matrix: which cases, which candidates,
 * how they ladder from each other, the cache workload, and the ceilings the run must
 * obey. It deliberately does **not** name a model, an endpoint or a credential — those
 * belong to the resource decision (RQ-H1B), so the matrix can be frozen before any
 * provider is chosen and a later run supplies only the transport.
 *
 * The json schemas in `evals/experiments/schema/` publish the same shapes, and every
 * document is checked against them when it loads. The experiment's own schema lives
 * beside its data rather than in `evals/schemas/`, because the run documents' schema
 * directory is compiled as one set and this contract is not part of it.
 */

import type { RunBounds } from '../run/types.js';

/** The definition document's version. */
export const EXPERIMENT_VERSION = 'rq14-experiment-v1';

/** The cases one experiment selects. */
export interface ExperimentDataset {
  readonly datasetId: string;
  readonly datasetPath: string;
  readonly split: 'dev' | 'calibration' | 'holdout' | 'all';
  /** An explicit selection; omitted means the split decides, once per candidate. */
  readonly caseIds?: readonly string[];
}

/**
 * Candidate B's question, fixed in the record.
 *
 * Every member is checked against the code that renders the question (`src/reviewer/
 * probe.ts`), so a definition cannot describe a probe the reviewer does not ask. That
 * is what "the definition and the `unknown` representation are fixed in the experiment
 * record" means as an executable claim rather than a sentence.
 */
export interface ProbeDefinition {
  readonly version: string;
  readonly member: string;
  readonly options: readonly string[];
  /** The one legal way to say the material does not establish the answer. */
  readonly unknown: string;
  /** The rule that the probe never changes either band. */
  readonly bandRule: string;
  /** The rule that `withdrawn` is read by the authorization scale, never gated here. */
  readonly withdrawnRule: string;
}

/** One candidate's four axes, in the definition's own spelling. */
export interface CandidateAxes {
  readonly prompt: 'no-probe' | 'recovery-probe';
  readonly structure: 'full' | 'compact' | 'compact-no-audit';
  readonly history: 'current-turn' | 'none';
  readonly scale: 'complete' | 'labels';
}

/** One candidate package. */
export interface CandidateDefinition {
  readonly candidateId: string;
  readonly label: string;
  readonly axes: CandidateAxes;
}

/** One ablation step: a candidate, and the one axis it changes. */
export interface LadderStep {
  readonly stepId: string;
  readonly from: string;
  readonly changes: readonly (keyof CandidateAxes)[];
  readonly axes: CandidateAxes;
}

/** One request in the cache workload. */
export interface CacheSlot {
  readonly role: 'cold' | 'stable-prefix' | 'changed-action';
  readonly repeats: number;
}

/**
 * The cache workload.
 *
 * The layout is stated as the hypothesis it is: this repository cannot make a provider
 * cache anything. What it *can* do is send a cold request and then a run of requests
 * whose prefix never changes, and read the provider's own cache counts back through the
 * production usage mapping. Counts a provider does not report stay unknown.
 *
 * The workload is described by the two things it is built from, not only by labels:
 * `baseCaseId` supplies the material every request shares, and `changedActionCaseIds`
 * supplies the actions the changed-action slots submit, in order. `expandCache` renders
 * each request from them, so the prefix and the action change are measured rather than
 * described.
 */
export interface CacheWorkload {
  readonly prefix: string;
  readonly changing: string;
  /**
   * The case whose policy, environment, authorization and history every request shares.
   *
   * The cold request submits this case's own action; a changed-action slot submits the
   * action of the case it names while keeping this case's prefix.
   */
  readonly baseCaseId: string;
  /**
   * The actions the changed-action slots submit, one per slot repeat, in order.
   *
   * Listed explicitly rather than derived from a split, so raising a slot's `repeats`
   * cannot quietly reuse an action: a workload asking for more actions than it names is
   * refused.
   */
  readonly changedActionCaseIds: readonly string[];
  readonly sequence: readonly CacheSlot[];
  readonly reading: string;
}

/**
 * The ceilings this experiment may spend.
 *
 * `maxRequests` bounds every request, repairs included; `maxInputTokensTotal` bounds the
 * measured input; `maxRepairRetries` is per cell. The experiment's own request count is
 * compared with the *run* bounds too (`bounds.maxAttempts`, `bounds.maxInputTokens`),
 * because those are what one bounded run enforces: a matrix needing more dispatches than
 * a run allows is not a plan, whatever its own ceiling says.
 */
export interface ExperimentBudget {
  readonly maxRequests: number;
  readonly maxInputTokensTotal: number;
  readonly maxRepairRetries: number;
  readonly reasoningEffort: string | null;
}

/** One frozen candidate matrix. */
export interface ExperimentDefinition {
  readonly experimentVersion: typeof EXPERIMENT_VERSION;
  readonly experimentId: string;
  readonly description: string;
  /**
   * What a reader must not over-read.
   *
   * Required rather than optional: an experiment that hides its own limits is
   * indistinguishable from one that has none, and this task is explicitly forbidden from
   * claiming a pass on unexecuted evidence.
   */
  readonly notes: readonly string[];
  readonly dataset: ExperimentDataset;
  readonly protocols: readonly ('chat' | 'decision')[];
  readonly repeats: number;
  readonly probe: ProbeDefinition;
  readonly candidates: readonly CandidateDefinition[];
  readonly ladder: readonly LadderStep[];
  readonly cache: CacheWorkload;
  readonly bounds: RunBounds;
  readonly budget: ExperimentBudget;
  readonly nonGoals: readonly string[];
}
