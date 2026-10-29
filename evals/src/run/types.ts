/**
 * The run artifact's TypeScript shape.
 *
 * Four documents describe one bounded evaluation run, and they are separate on
 * purpose:
 *
 *   plan     what will be run, frozen and hashed before anything is sent
 *   index    the run's mutable state: which cells have a record and what it spent
 *   record   one cell's content, written once and never rewritten
 *   fixture  the scripted socket an offline run replays
 *
 * The split is what makes an interrupted run resumable without losing evidence:
 * the index can be rewritten as often as needed, and a record cannot be rewritten
 * at all. A reader that walks `records/` therefore sees exactly the attempts that
 * actually ran, in the order they ran, and a continuation can only add to that set.
 *
 * Nothing in this module decides anything. The outcome, the scores and the verdict
 * are the shared review contract's own types (`src/review-contract/`), and the
 * attempt is the production adapter's own type (`src/reviewer/attempt.ts`), so a
 * report consuming a record reads the same values production logs.
 */

import type { ReviewOutcome } from '../../../src/review-contract/types.js';
import type { ReviewAttempt } from '../../../src/reviewer/attempt.js';
import type {
  UsageAggregate,
  UsageNormalized,
} from '../../../src/reviewer/usage.js';
import type { MaterialGapKind } from '../../../src/types.js';

/**
 * The version of the artifact format as a family.
 *
 * This is what a report compares, and it is deliberately one value for the whole set
 * of run documents: a report that can read one of them can read all of them, and telling
 * a reader "these four files belong to one format era" is more useful than four
 * independent numbers it would have to cross-check. A change to any document's member
 * meanings — not to its spelling — requires a new value here.
 */
export const RUN_ARTIFACT_VERSION = 'eval-run-artifact-v1';

/** The plan document's own version. */
export const RUN_PLAN_VERSION = 'eval-run-plan-v1';

/** The run index's own version. */
export const RUN_INDEX_VERSION = 'eval-run-index-v1';

/** One cell record's own version. */
export const CELL_RECORD_VERSION = 'eval-cell-record-v1';

/** The fixture document's version. */
export const RUN_FIXTURE_VERSION = 'eval-offline-fixture-v1';

/**
 * The runner implementation's own version.
 *
 * Bumped when this runner changes what it does — which bound it enforces, how it
 * classifies an attempt, what it writes — but not when the contract, the prompt or
 * the usage mapping changes. Those have their own versions, and a report compares
 * runs by all four.
 */
export const RUNNER_IMPLEMENTATION_VERSION = 'eval-runner-v1';

/** The two protocols a review can run through. */
export type RunProtocol = 'chat' | 'decision';

/** Which half of a target's configuration a protocol uses. */
export type RunTransportName = 'offline' | 'live';

/** One model x protocol cell's transport configuration, as the plan froze it. */
export interface ChatTargetConfig {
  readonly provider: string;
  readonly model: string;
  readonly temperature: number;
  readonly maxTokens: number;
  readonly timeoutMs: number;
  readonly maxRepairRetries: number;
  readonly reasoningEffort?: string;
}

export interface DecisionTargetConfig {
  readonly url: string;
  readonly model: string;
  readonly apiKeyRef: string;
  readonly timeoutMs: number;
  readonly costTier: 'free' | 'paid';
}

/**
 * One model, through the protocols it actually supports.
 *
 * A protocol the model does not support is `null` here and never a placeholder
 * configuration: that is what lets the runner mark the grid cell `unsupported`
 * instead of sending a request nobody could answer.
 */
export interface RunTarget {
  readonly targetId: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly chat: ChatTargetConfig | null;
  readonly decision: DecisionTargetConfig | null;
  readonly credentialRef: string | null;
}

/** The ceilings a run obeys. */
export interface RunBounds {
  readonly concurrency: number;
  readonly timeoutMs: number;
  /** Model attempts across the whole run, counted by worst case before dispatch. */
  readonly maxAttempts: number;
  /** Dispatch budget: a cell is not started when its estimated input would exceed this. */
  readonly maxInputTokens: number;
}

/** The frozen experiment. */
export interface RunPlan {
  readonly planVersion: typeof RUN_PLAN_VERSION;
  readonly datasetId: string;
  readonly datasetPath: string;
  readonly split: 'dev' | 'calibration' | 'holdout' | 'all';
  readonly caseIds: readonly string[];
  readonly transport: RunTransportName;
  readonly protocols: readonly RunProtocol[];
  readonly targets: readonly RunTarget[];
  readonly repeats: number;
  readonly bounds: RunBounds;
  readonly context: { readonly maxInputTokens: number };
  readonly fixture: string | null;
  readonly notes: readonly string[];
}

/** Which split a plan selects, or every case. */
export type PlanSplit = RunPlan['split'];

/** How one attempt came to exist. */
export type RunAttemptKind =
  /** The attempt the plan asked for. */
  | 'initial'
  /** The production transport's own re-ask after an unreadable answer. */
  | 'repair';

/**
 * One actual model attempt, exactly as the production adapter reported it.
 *
 * `kind` is added here rather than inferred later: a repair is the transport's own
 * second ask, and an independent repeat is a different cell. Both cost money, and
 * only one of them is a second observation for stability, so the difference has to
 * travel with the record instead of being guessed from an attempt number.
 */
export interface RunAttempt extends ReviewAttempt {
  readonly kind: RunAttemptKind;
}

/** What one cell is, relative to the run's plan. */
export interface CellExecution {
  /** `original` is the plan's own pass; `repeat` is an independent second observation. */
  readonly origin: 'original' | 'repeat';
  readonly repeat: number;
  readonly transport: RunTransportName;
}

/**
 * Which input chain produced this review.
 *
 * These are different claims and a report must not merge them:
 * `direct-service` calls the production reviewer with material assembled from the
 * case, so it says what the reviewer does to that material; it does not exercise
 * the host's session-log collector, configuration, or approval channel. A result
 * measured here is a reviewer result, not a host-behaviour result.
 */
export interface CellEntryPoint {
  readonly kind: 'direct-service' | 'host-chain';
  readonly materialChain: 'case-input' | 'session-log';
  readonly detail: string;
}

/** What the reviewer was given, and the fingerprints that identify it. */
export interface CellMaterial {
  /** The same canonical digest a label is approved against. */
  readonly inputHash: string;
  /**
   * Digest of the exact text the production renderer produced for this protocol.
   *
   * It is taken from the rendered request, which is what a provider receives, and not
   * from the attempt's stored `request` — that copy has already crossed the adapter's
   * credential mask, so it may differ from the submitted text in ways that have nothing
   * to do with this run. Two cells with the same fingerprint therefore sent the same
   * question, which is the comparison a report makes; a reader that wants the bytes
   * reads the attempt.
   */
  readonly promptFingerprint: string;
  readonly estimatedInputTokens: number;
  readonly maxInputTokens: number;
  readonly truncatedSegments: readonly string[];
  readonly completenessStatus: 'complete' | 'incomplete' | 'insufficient';
  readonly blockingGaps: readonly {
    readonly source: string;
    readonly reason: string;
  }[];
  readonly missing: readonly string[];
  /**
   * Non-blocking observations about the submission, copied from the production
   * completeness report. They are input facts, and a report must not read them as
   * findings about the action.
   */
  readonly notices: readonly {
    readonly source: string;
    readonly kind: MaterialGapKind;
    readonly reason: string;
  }[];
}

/** Which model the plan asked for, and which model answered. */
export interface CellTargetRecord {
  readonly targetId: string;
  readonly provider: string;
  readonly configuredModel: string;
  readonly modelVersion: string | null;
  readonly protocol: RunProtocol;
  /**
   * The wire protocol the production renderer stamped on the attempt.
   *
   * Null when no attempt ran: a cell that never reached a transport has no protocol
   * to report, and filling in the plan's expectation would let a reader mistake
   * "this was meant to run as chat" for "this ran as chat".
   */
  readonly protocolName: string | null;
  /** The model the response body named, when it named one. */
  readonly responseModel: string | null;
  /** The endpoint's configured tier. A classification of the route, not a price. */
  readonly costTier: 'free' | 'paid' | 'unknown';
}

/** What the reviewer produced, or why it produced nothing. */
export type CellStatus =
  /** The production service returned an outcome, whatever that outcome was. */
  | 'reviewed'
  /** This model does not offer this protocol; nothing was sent. */
  | 'unsupported'
  /** The caller's signal ended the cell while it was in flight. */
  | 'cancelled'
  /** The cell's own outer bound ended it. */
  | 'timeout'
  /** A ceiling stopped dispatch before this cell started. */
  | 'budget-exhausted'
  /** The cell could not be attempted at all. */
  | 'failed';

/**
 * Cost, as a status rather than a number.
 *
 * This runner does not price tokens: it does not know a provider's rate card, and
 * a `0` here would read as "this call was free", which is a different fact from
 * "nobody computed it". A report that prices cells writes its own document; it
 * must not fill this one in, because then an unknown and a real zero would become
 * the same value in the artifact.
 */
export interface CellCost {
  readonly status: 'not-computed' | 'not-applicable';
  readonly amount: null;
  readonly currency: null;
  readonly reason: string;
}

/** One cell's immutable record. */
export interface CellRecord {
  readonly documentVersion: typeof CELL_RECORD_VERSION;
  readonly runId: string;
  readonly cellId: string;
  readonly createdAt: string;
  readonly case: {
    readonly caseId: string;
    readonly familyId: string;
    readonly split: 'dev' | 'calibration' | 'holdout';
    readonly provenanceSource: 'real' | 'reconstructed' | 'synthetic';
    readonly inputHash: string;
  };
  readonly execution: CellExecution;
  readonly entryPoint: CellEntryPoint;
  readonly target: CellTargetRecord;
  /**
   * What the reviewer was given, including the fingerprints above.
   *
   * Null only for a cell that was never dispatched. The attempt's own `request` member
   * is separate and already masked; this member never carries the credential mask's
   * edits into a fingerprint.
   */
  readonly material: CellMaterial | null;
  readonly status: CellStatus;
  readonly stopReason: string | null;
  readonly outcome: ReviewOutcome | null;
  readonly attempts: readonly RunAttempt[];
  readonly usage: UsageAggregate | null;
  readonly cost: CellCost;
  readonly timing: { readonly startedAt: number; readonly durationMs: number };
  readonly versions: RunVersions;
  readonly notes: readonly string[];
}

/**
 * What produced a run.
 *
 * Two runs are comparable only when the first three agree: the contract, the prompt and
 * the usage mapping decide what a recorded number means. The rest identify the build —
 * which plan document, which artifact era, which runner — so a reader can tell a
 * re-run from a different experiment.
 */
export interface RunVersions {
  readonly contract: string;
  readonly prompt: string;
  readonly usageMapping: string;
  readonly plan: string;
  readonly artifact: string;
  readonly implementation: string;
  /** Present on a run's own versions; a record inherits its run's and omits it. */
  readonly node?: string;
}

/** What the run has spent so far, recomputed from the records rather than accumulated. */
export interface RunSpend {
  readonly cellsStarted: number;
  readonly cellsCompleted: number;
  readonly cellsPlanned: number;
  readonly attempts: number;
  readonly estimatedInputTokens: number;
  /** Null when no attempt reported an output count; never zero in its place. */
  readonly reportedOutputTokens: number | null;
}

/** The index's view of one cell. */
export interface CellState {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  /** Dataset-independent path to this cell's record, relative to the run directory. */
  readonly record: string;
  readonly status: CellStatus | 'not-run';
  readonly attempts: number;
  readonly stopReason: string | null;
}

/** Why a run stopped short of its plan. */
export type RunStatus =
  'running' | 'complete' | 'cancelled' | 'budget-exhausted' | 'failed';

/** The run's mutable document. */
export interface RunIndex {
  readonly documentVersion: typeof RUN_INDEX_VERSION;
  readonly runId: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly status: RunStatus;
  readonly plan: RunPlan;
  readonly planHash: string;
  readonly dataset: {
    readonly datasetId: string;
    readonly digest: string;
    readonly caseCount: number;
    readonly caseIds: readonly string[];
  };
  readonly versions: RunVersions;
  readonly transport: RunTransportName;
  readonly bounds: RunBounds;
  readonly spent: RunSpend;
  readonly cells: readonly CellState[];
  readonly resumed: readonly {
    readonly at: string;
    readonly completedBefore: number;
    readonly plannedAfter: number;
  }[];
  readonly notes: readonly string[];
}

/**
 * One scripted chat stream, in the production offline adapter's own vocabulary.
 *
 * `text` arrives and the production parser reads it; `failure` is the provider
 * declaring its own failure, which no repair may retry; `truncated` is a stream
 * that ends with no terminal finish, as a dropped connection does. A fixture
 * therefore cannot express an outcome the adapter could not produce.
 */
export type FixtureChatScript =
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly usage?: unknown;
    }
  | {
      readonly kind: 'failure';
      readonly code: string;
      readonly message: string;
      readonly usage?: unknown;
    }
  | { readonly kind: 'truncated' };

/** One scripted decision response: an HTTP status and a body. */
export interface FixtureResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * What the fixture replays for one cell.
 *
 * Both members are present and one of them is null: a fixture states which
 * protocol it scripts, so a decision cell cannot accidentally be served a chat
 * stream it never asked for.
 */
export interface FixtureCell {
  readonly chat: readonly FixtureChatScript[] | null;
  readonly decision: readonly FixtureResponse[] | null;
}

/** The scripted socket an offline run replays. */
export interface RunFixture {
  readonly fixtureVersion: typeof RUN_FIXTURE_VERSION;
  readonly description: string;
  /** Keyed by cell id, so a cell's replay cannot depend on another cell's order. */
  readonly cells: Readonly<Record<string, FixtureCell>>;
  readonly notes: readonly string[];
}

/** One attempt's usage, as the record stores it. */
export type AttemptUsage = UsageNormalized | null;
