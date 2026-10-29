/**
 * The evaluation report document.
 *
 * A report answers three questions that must not be answered together, because
 * merging them hides the thing a reader needs to act on:
 *
 *   behaviour   what the reviewer did to the reviewed call, against the human
 *               reference: allowed what should be refused, refused what was
 *               allowed, or asked a person when nobody needed to be asked.
 *   diagnostics the two 1–10 scores behind that behaviour, so a wrong verdict can
 *               be traced to a wrong band rather than to a wrong rule.
 *   settlement  what the host would actually do with the review under one ask
 *               mode and one approval channel: allow, deny, ask a human, or deny
 *               because nobody can be asked.
 *
 * A cell that never produced a judgeable answer belongs to none of the three. It
 * is a technical outcome, and counting it as a denial is how a broken transport
 * gets reported as a cautious reviewer.
 *
 * Every figure carries its own denominator. `null` means "no denominator", never
 * zero: a rate over no comparable cell is unknown, which is a different fact from
 * a rate that was measured and came out at zero. The same rule governs token
 * counts and cost, where a zero would read as a measured value.
 *
 * Nothing here reads a clock or the environment. Ordering is by code point, never
 * by locale, so the same artifact produces the same document on any machine.
 */

import type { AskPolicy } from '../../../src/review-contract/index.js';
import type {
  UsageAggregate,
  UsageField,
} from '../../../src/reviewer/usage.js';
import type { LabelVersions } from '../data/types.js';
import type { CellState, RunProtocol } from '../run/types.js';

/** The report document's own version. A change to any member's meaning bumps it. */
export const REPORT_FORMAT_VERSION = 'eval-report-v1';

/** The three layers, named so a consumer can point at one without parsing prose. */
export type ReportLayer = 'behaviour' | 'diagnostics' | 'settlement';

/** The word a review's matrix verdict stands for. */
export type BehaviourWord = 'allow' | 'deny' | 'escalate';

/** What the engine said about one cell. */
export type EngineWord =
  BehaviourWord | 'insufficient-material' | 'review-failure';

/**
 * What the user's label says the call should reach.
 *
 * The last two are not behaviours the matrix produces; they record that the right
 * answer was "no answer" or "a failure", which is a different comparison and is
 * counted in its own class rather than folded into the allow/deny axis.
 */
export type ReferenceWord = EngineWord;

/**
 * One cell's place in the confusion table.
 *
 * The classes are mutually exclusive and exhaustive, so their counts add up to the
 * number of planned cells. Only the first eight are part of the compared
 * denominator: a technical outcome, a missing record and a pre-dispatch refusal are
 * all *outside* it, because none of them is a decision about the reviewed call.
 */
export type BehaviourClass =
  /** The engine allowed a call the reference refuses or escalates. */
  | 'false-allow'
  /** The engine refused a call the reference allows or escalates to a person. */
  | 'false-deny'
  /** The engine asked a human where the reference already answers "allow". */
  | 'unnecessary-human'
  /** The engine asked a human where the reference answers "deny". */
  | 'escalate-not-deny'
  /** The reference records that no score was possible, but the engine produced a verdict. */
  | 'material-unavailable-but-scored'
  /** The reference records a review failure, but the engine produced a verdict. */
  | 'failure-expected-but-not-reported'
  /** The engine declined to score material the reference could judge. */
  | 'undecided'
  /** The engine reached exactly the reference behaviour. */
  | 'matched'
  /** A cell was dispatched and produced no judgeable answer. */
  | 'technical'
  /** The index claims a dispatched status, but no record exists. */
  | 'missing-record'
  /** The cell was decided before dispatch: unsupported, out of budget, never started. */
  | 'not-run'
  /** The cell was judged, but its case has no gold label. */
  | 'uncompared';

/**
 * Every class a cell can take, in the order the report prints them.
 *
 * The classes a reader must act on come first, and the three outside the compared
 * denominator come last, so a table never opens with figures that are not errors.
 */
export const BEHAVIOUR_CLASSES: readonly BehaviourClass[] = [
  'false-allow',
  'false-deny',
  'unnecessary-human',
  'escalate-not-deny',
  'material-unavailable-but-scored',
  'failure-expected-but-not-reported',
  'undecided',
  'matched',
  'technical',
  'missing-record',
  'not-run',
  'uncompared',
];

/** The classes that are part of the compared denominator. */
export const COMPARED_CLASSES: readonly BehaviourClass[] = [
  'false-allow',
  'false-deny',
  'unnecessary-human',
  'escalate-not-deny',
  'material-unavailable-but-scored',
  'failure-expected-but-not-reported',
  'undecided',
  'matched',
];

/** The classes that are an engine error, as opposed to a match. */
export const ERROR_CLASSES: readonly BehaviourClass[] = [
  'false-allow',
  'false-deny',
  'unnecessary-human',
  'escalate-not-deny',
  'material-unavailable-but-scored',
  'failure-expected-but-not-reported',
  'undecided',
];

/** One cell's engine-side answer, as the artifact recorded it. */
export interface EngineAnswer {
  /** The word this outcome stands for, or null when the cell produced no outcome. */
  readonly word: EngineWord | null;
  readonly verdict: string | null;
  readonly risk: number | null;
  readonly authorization: number | null;
  /** The weakest authorization the shared matrix permits at this risk. */
  readonly requiredAuthorization: number | null;
  /** The reviewer's own reason for an insufficiency or a failure. */
  readonly reason: string | null;
}

/**
 * Rates that treat one case as one sample.
 *
 * Related variants share a seed and repeats share a case, so neither is an
 * independent observation. Averaging per-case rates rather than pooling cells is
 * the cheapest honest correction: a case run three times contributes one rate
 * instead of three.
 */
export interface CaseBalancedRates {
  readonly cases: number;
  readonly compared: number;
  readonly agreementRate: number | null;
  readonly falseAllowRate: number | null;
  readonly falseDenyRate: number | null;
  readonly unnecessaryHumanRate: number | null;
}

/** The class counts, plus the denominators they must be read against. */
export interface BehaviourCounts {
  /** Cells in this population, whatever they produced. */
  readonly cells: number;
  /** Cells whose outcome was an actual statement about the call. */
  readonly judged: number;
  /** Cells whose case has a gold label. */
  readonly referenceKnown: number;
  /** Cells compared with a reference: judged and reference-known together. */
  readonly compared: number;
  readonly byClass: Readonly<Record<BehaviourClass, number>>;
  readonly matched: number;
  readonly falseAllow: number;
  readonly falseDeny: number;
  readonly unnecessaryHuman: number;
  readonly escalateNotDeny: number;
  readonly materialUnavailableButScored: number;
  readonly failureExpectedButNotReported: number;
  readonly undecided: number;
  readonly technical: number;
  readonly missingRecord: number;
  readonly notRun: number;
  readonly uncompared: number;
  readonly falseAllowRate: number | null;
  readonly falseDenyRate: number | null;
  readonly unnecessaryHumanRate: number | null;
  readonly errorRate: number | null;
  readonly agreementRate: number | null;
  readonly caseBalanced: CaseBalancedRates;
}

/** The axes the report groups by, in print order. */
export type GroupAxis =
  'challenge' | 'provenance' | 'family' | 'protocol' | 'target';

/** One group's behaviour counts. */
export interface BehaviourGroup {
  readonly axis: GroupAxis;
  readonly key: string;
  /** A human word for the key, so a table does not print the raw enum. */
  readonly title: string;
  readonly counts: BehaviourCounts;
}

/** Layer one: the automatic behaviour metrics. */
export interface BehaviourSection {
  readonly overall: BehaviourCounts;
  readonly byGroup: readonly BehaviourGroup[];
}

/** One label, as the report accounts for it. */
export interface LabelRow {
  readonly caseId: string;
  readonly outcome:
    | 'gold'
    | 'missing'
    | 'excluded'
    | 'case-absent'
    | 'input-mismatch'
    | 'authority-conflict';
  /** Why a label is not gold; empty for a gold label. */
  readonly reasons: readonly string[];
  readonly status: 'pending' | 'approved' | 'disputed' | null;
  readonly reference: ReferenceWord | null;
  readonly pairs: number;
  readonly versions: LabelVersions | null;
  readonly rationale: string | null;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
}

/** How many labels could count, and why the rest could not. */
export interface LabelCoverage {
  /** Whether a dataset was read and its labels joined to the run's cases. */
  readonly source: 'joined' | 'absent' | 'unreadable';
  readonly datasetId: string | null;
  readonly datasetPath: string | null;
  /** The digest of the cases and manifest the run executed, as the run recorded it. */
  readonly executionDigest: string | null;
  /** The versions the dataset's manifest declares. */
  readonly versions: LabelVersions | null;
  /** Cases the run observed, whether or not a label exists for them. */
  readonly cases: number;
  readonly gold: number;
  readonly excluded: number;
  readonly missing: number;
  /** Labels whose input fingerprint does not match what the run submitted. */
  readonly inputMismatch: number;
  /** Cases whose adjudication is contested, so no reference is used. */
  readonly authorityConflict: number;
  readonly pending: number;
  readonly disputed: number;
  readonly excludedByReason: Readonly<Record<string, number>>;
  readonly rows: readonly LabelRow[];
}

/** The score-error statistics for one field. */
export interface FieldErrorStats {
  readonly field: 'risk' | 'authorization';
  /** Cells whose reference names exactly one value for this field. */
  readonly comparable: number;
  readonly exact: number;
  readonly adjacent: number;
  readonly far: number;
  readonly meanSigned: number | null;
  readonly meanAbsolute: number | null;
  readonly maxAbsolute: number | null;
  /** Every comparable cell's signed error, so a reader can check the summary. */
  readonly errors: readonly {
    readonly caseId: string;
    readonly observed: number;
    readonly reference: number;
    readonly delta: number;
  }[];
}

/** Whether the engine landed on a pair the adjudicator actually allowed. */
export interface PairStats {
  readonly labeled: number;
  readonly exactPair: number;
  /** Cells whose pair sat outside the allowed pairs, with the distance to the nearest one. */
  readonly outside: readonly {
    readonly caseId: string;
    readonly observed: readonly [number, number];
    readonly distance: number;
  }[];
  readonly pairRate: number | null;
}

/**
 * Reverse monotonicity: a case the reference ranks higher must not be ranked lower.
 *
 * Ties are allowed — the scale is ten ordered levels and two different cases can
 * legitimately share one. What is not allowed is the reverse order, which is why
 * only pairs the reference *strictly* orders are compared.
 */
export interface MonotonicityStats {
  readonly field: 'risk' | 'authorization';
  readonly comparablePairs: number;
  readonly reversals: number;
  readonly ties: number;
  readonly reversalRate: number | null;
  readonly violations: readonly {
    readonly higher: string;
    readonly lower: string;
    readonly reference: readonly [number, number];
    readonly observed: readonly [number, number];
  }[];
}

/** The score distribution one field took, against the reference distribution. */
export interface ShapeStats {
  readonly field: 'risk' | 'authorization';
  /** Counts per public level, `"1"`…`"10"`, in ascending order. */
  readonly observed: Readonly<Record<string, number>>;
  readonly reference: Readonly<Record<string, number>> | null;
  readonly observedCells: number;
  readonly referenceCells: number;
  readonly mode: number | null;
  readonly modeShare: number | null;
  readonly distinct: number;
  readonly mean: number | null;
}

/** Layer two: the R/A diagnostics. */
export interface DiagnosticsSection {
  readonly labels: LabelCoverage;
  readonly risk: FieldErrorStats;
  readonly authorization: FieldErrorStats;
  readonly pairs: PairStats;
  readonly monotonicity: readonly MonotonicityStats[];
  readonly shape: readonly ShapeStats[];
}

/** What the host would do with one review, or why it did nothing. */
export type SettlementKind =
  'allow' | 'deny' | 'ask-human' | 'fallback-deny' | 'not-reviewed';

/** Settlement counts for one population. */
export interface SettlementCounts {
  readonly cells: number;
  readonly allow: number;
  readonly deny: number;
  readonly askHuman: number;
  readonly fallbackDeny: number;
  readonly notReviewed: number;
  /** Human questions where the reference answers allow or deny. */
  readonly unnecessaryHuman: number;
  /** Human questions where the reference says a person should decide. */
  readonly necessaryHuman: number;
  /** Human questions with no gold label, so necessity is unknown. */
  readonly unknownNecessity: number;
  /**
   * The settlements that came from a technical stage rather than a verdict.
   *
   * Broken out so a reader can tell "the reviewer asked about 12 cases" from "the
   * reviewer broke on 12 cases and each break was handed to a person". The totals
   * already include these; this is the part that says why.
   */
  readonly technical: {
    readonly askHuman: number;
    readonly fallbackDeny: number;
    readonly notReviewed: number;
  };
}

/** One group's settlement counts. */
export interface SettlementGroup {
  readonly axis: GroupAxis;
  readonly key: string;
  readonly title: string;
  readonly counts: SettlementCounts;
}

/**
 * Layer three: the actual mode and the human/host settlement.
 *
 * `projection` is true when no cell ran through the host chain. Then this layer is
 * what the shared settlement rule *would* instruct, not what a host observed, and
 * saying so is the difference between evidence and a claim about a system nobody
 * exercised.
 */
export interface SettlementSection {
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
  readonly projection: boolean;
  readonly overall: SettlementCounts;
  readonly byGroup: readonly SettlementGroup[];
}

/** One attempt's usage, exactly as the artifact stored it. */
export interface AttemptUsageRow {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly attemptId: string;
  readonly attemptNumber: number;
  readonly kind: 'initial' | 'repair';
  readonly sent: boolean;
  readonly durationMs: number;
  /** The adapter's own estimate, never the provider's report. */
  readonly estimatedInputTokens: number;
  readonly tokens: Readonly<Record<UsageField, number | null>>;
  readonly mappingVersion: string | null;
  readonly source: string | null;
  /** Paths present in the payload that held no usable count. */
  readonly ignored: readonly string[];
}

/** One usage aggregate over a named subset. */
export interface UsageScope {
  readonly key: string;
  readonly cells: number;
  /** Null when no cell in this scope ran a sent attempt. */
  readonly aggregate: UsageAggregate | null;
  /**
   * The six buckets, each with its own sum and coverage.
   *
   * This is what a scope table prints instead of three columns and one flag: a scope where
   * two attempts reported `totalTokens` but only one reported `inputTokens` has a partial
   * input sum, and a single `complete` flag derived from one bucket would present it as
   * whole.
   */
  readonly fields: readonly {
    readonly field: UsageField;
    readonly total: number | null;
    readonly reported: number;
    readonly missing: number;
    readonly complete: boolean;
  }[];
}

/** One cell's usage, with the cross-check against the record's own summary. */
export interface CellUsage {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly status: string;
  /** The aggregate this report publishes, recomputed from the stored attempts. */
  readonly aggregate: UsageAggregate | null;
  /**
   * The summary the record itself stored.
   *
   * Kept beside the recomputation so a reader can see both when they disagree: the report
   * publishes the recomputation and states that the artifact's own figure differed, which
   * is only checkable if the original is still there.
   */
  readonly storedAggregate: UsageAggregate | null;
  /** Whether re-aggregating the attempts reproduced the record's own `usage`. */
  readonly matchesRecord: boolean;
}

/**
 * The usage extension: per attempt, per review, and per model, protocol and run.
 *
 * The figures are the shared aggregate's own, re-derived from the attempts the
 * record kept. Nothing here is a second mapping: cache reads and reasoning stay in
 * their own buckets with their declared inclusion, so a reader cannot add a
 * contained sub-count to its parent and call it a total.
 */
export interface UsageSection {
  readonly mappingVersion: string;
  readonly attempts: readonly AttemptUsageRow[];
  readonly run: UsageAggregate | null;
  readonly byCell: readonly CellUsage[];
  readonly byModel: readonly UsageScope[];
  readonly byProtocol: readonly UsageScope[];
  readonly byTarget: readonly UsageScope[];
  /**
   * The adapter's estimate, kept apart from the provider's report.
   *
   * They answer different questions — what was thought to be sent against what the
   * provider says it counted — and a report that added them would produce a number
   * that is neither.
   */
  readonly estimated: {
    readonly inputTokens: number | null;
    readonly attempts: number;
    readonly cells: number;
  };
  /** Attempts a cell reserved before dispatch and never reported; they may have cost money. */
  readonly unreportedReservations: number;
  readonly notes: readonly string[];
}

/** One case/target/protocol's independent repeats. */
export interface RepeatGroup {
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeats: number;
  readonly judged: number;
  readonly answers: readonly {
    readonly repeat: number;
    readonly risk: number;
    readonly authorization: number;
    readonly behaviour: BehaviourWord;
  }[];
  /**
   * Whether the repeats agree, or null when there is not enough evidence to say.
   *
   * A group with fewer than two judged answers has no pair to compare: calling that stable
   * would turn a timeout into a clean stability result.
   */
  readonly stable: boolean | null;
  readonly distinctAnswers: number;
  readonly riskSpread: number | null;
  readonly authorizationSpread: number | null;
}

/** How many samples there really are, once correlation is accounted for. */
export interface SampleWeights {
  readonly cells: number;
  readonly records: number;
  readonly distinctCases: number;
  readonly distinctFamilies: number;
  readonly distinctTargets: number;
  readonly distinctProtocols: number;
  readonly repeats: number;
  /** Attempts the transport re-asked for, which are not repeats. */
  readonly repairs: number;
}

/** Repeats, kept apart from related variants and repairs. */
export interface StabilitySection {
  readonly samples: SampleWeights;
  readonly repeatGroups: readonly RepeatGroup[];
  readonly stableGroups: number;
  readonly unstableGroups: number;
  /** Groups with fewer than two judged answers, so stability is unknown. */
  readonly unassessableGroups: number;
  readonly withRepeats: number;
}

/** Timing for one population. */
export interface DurationStats {
  readonly cells: number;
  readonly totalMs: number;
  readonly meanMs: number | null;
  readonly medianMs: number | null;
  readonly maxMs: number | null;
}

/** Time and money, with the unknowns kept unknown. */
export interface EfficiencySection {
  readonly duration: DurationStats;
  readonly byTarget: readonly {
    readonly key: string;
    readonly duration: DurationStats;
  }[];
  readonly byProtocol: readonly {
    readonly key: string;
    readonly duration: DurationStats;
  }[];
  /**
   * Cost is a status, not a number.
   *
   * The runner does not price tokens and this report does not either, so there is
   * no total here. `amount` stays null, because a zero would read as a free call.
   */
  readonly cost: {
    readonly status: 'not-computed' | 'not-applicable' | 'mixed' | 'none';
    readonly amount: null;
    readonly currency: null;
    readonly cells: number;
    readonly reasons: readonly string[];
  };
}

/** Two protocols of one model compared on the same cases. */
export interface ProtocolComparison {
  readonly targetId: string;
  readonly model: string;
  readonly basis: 'one-target-two-protocols';
  readonly cases: number;
  readonly paired: number;
  readonly behaviourAgree: number;
  readonly scoreAgree: number;
  readonly differences: readonly {
    readonly caseId: string;
    readonly chat: readonly [number, number];
    readonly decision: readonly [number, number];
  }[];
}

/** A combination that differs in more than one thing and so is compared whole. */
export interface SystemCombination {
  readonly targetId: string;
  readonly model: string;
  readonly protocols: readonly string[];
  readonly reason: string;
}

/** What the plan could and could not support. */
export interface ComparisonSection {
  readonly protocolComparisons: readonly ProtocolComparison[];
  readonly systems: readonly SystemCombination[];
  readonly unsupported: readonly {
    readonly targetId: string;
    readonly protocols: readonly string[];
    readonly reason: string;
  }[];
  readonly notes: readonly string[];
}

/**
 * One cell, with everything the report says about it.
 *
 * This is the per-example evidence the summary points into: the input that was
 * reviewed (by hash and by path), the label it was compared against, what the
 * engine answered, how it was classified, and what the host would have done.
 */
export interface CellView {
  readonly cellId: string;
  readonly caseId: string;
  readonly familyId: string;
  readonly split: string;
  readonly provenance: string;
  /** The mechanisms that make this case a targeted challenge, in a fixed order. */
  readonly challenge: readonly string[];
  readonly challengeClass: 'ordinary' | 'targeted' | 'unclassified';
  readonly targetId: string;
  readonly provider: string;
  readonly model: string;
  readonly modelVersion: string | null;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  readonly origin: 'original' | 'repeat';
  readonly status: string;
  readonly outcomeStatus: string | null;
  readonly engine: EngineAnswer;
  readonly reference: ReferenceWord | null;
  readonly labelStatus:
    | 'gold'
    | 'missing'
    | 'excluded'
    | 'case-absent'
    | 'input-mismatch'
    | 'authority-conflict';
  readonly labelReasons: readonly string[];
  readonly labelVersions: LabelVersions | null;
  readonly classification: BehaviourClass;
  readonly settlement: SettlementKind;
  /** The same canonical digest a label is approved against. */
  readonly inputHash: string;
  /** Dataset-relative path of the case document, or null when the dataset did not resolve it. */
  readonly casePath: string | null;
  /** Which input supplied the case metadata: the saved record, the dataset, or both. */
  readonly caseFactsSource: 'record' | 'dataset' | 'record-and-dataset' | null;
  /** Whether the dataset has been reorganised away from what the run recorded. */
  readonly caseFactsConflict: boolean;
  readonly labelPath: string | null;
  /** The production service's own reason for an insufficiency or a failure. */
  readonly reason: string | null;
  /** The adjudicator's rationale, copied and never rewritten. */
  readonly rationale: string | null;
  readonly attempts: number;
  readonly durationMs: number;
  readonly tokens: Readonly<Record<UsageField, number | null>>;
  readonly costStatus: 'not-computed' | 'not-applicable' | null;
}

/** One place where the engine and a reference, repeat or protocol disagree. */
export interface DifferenceRow {
  readonly kind: 'behaviour' | 'score' | 'repeat' | 'protocol' | 'label';
  readonly cellId: string;
  readonly caseId: string;
  readonly observed: string;
  readonly expected: string;
  readonly detail: string;
}

/** A claim the report verifies about its own inputs. */
export interface ReportCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

/** What produced the report, taken from the run index rather than from a clock. */
export interface RunIdentity {
  readonly runId: string;
  readonly status: string;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly planHash: string;
  readonly datasetId: string;
  readonly datasetDigest: string;
  readonly datasetCaseCount: number;
  readonly transport: 'offline' | 'live';
  readonly repeats: number;
  readonly protocols: readonly RunProtocol[];
  readonly targets: readonly {
    readonly targetId: string;
    readonly provider: string;
    readonly model: string;
    readonly modelVersion: string | null;
    readonly protocols: readonly RunProtocol[];
  }[];
  readonly versions: {
    readonly contract: string;
    readonly prompt: string;
    readonly usageMapping: string;
    readonly plan: string;
    readonly artifact: string;
    readonly implementation: string;
    readonly node: string | null;
  };
  /** Which input chains produced these cells, as the records declared them. */
  readonly entryPoints: readonly string[];
}

/** What the run planned, recorded, and failed to record. */
export interface CoverageSummary {
  readonly cellsPlanned: number;
  readonly records: number;
  /** Cells that claim to have run but have no record: a real gap, not an interim state. */
  readonly missing: readonly CellState[];
  readonly statuses: Readonly<Record<string, number>>;
  readonly attempts: number;
  readonly sentAttempts: number;
  /** Attempts a cell reserved before dispatch and never reported. */
  readonly reservedAttempts: number;
  readonly observedCases: number;
  readonly observedFamilies: number;
}

/**
 * Which dataset a report joins its labels from.
 *
 * Three choices rather than a nullable path, because "the caller named none" and "the
 * caller asked for no dataset" are different requests. A run records the dataset it
 * executed, and defaulting to that is what makes a rebuild reproducible; a caller that
 * wants the behaviour-only report has to say so, and then the report states that no label
 * was joined instead of quietly reading one anyway.
 */
export type DatasetSource =
  /** The dataset the run recorded in its index. */
  | { readonly kind: 'recorded' }
  /** No dataset: no label is joined and every gold figure has no denominator. */
  | { readonly kind: 'none' }
  /** An explicit dataset, relative to the root or absolute. */
  | { readonly kind: 'path'; readonly path: string };

/** The settings the report was asked for, which are not properties of the artifact. */
export interface ReportSettings {
  /** Which ask policy the settlement layer is computed under. */
  readonly mode: AskPolicy;
  /** Whether an approval channel is reachable; an unavailable one settles escalations as denials. */
  readonly channel: 'available' | 'unavailable';
  readonly dataset: DatasetSource;
  /** A repository root against which a relative dataset path is resolved. */
  readonly root: string;
}

/** The report, as one document. */
export interface EvaluationReport {
  readonly formatVersion: typeof REPORT_FORMAT_VERSION;
  readonly run: RunIdentity;
  readonly setup: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
    readonly labels: 'joined' | 'absent' | 'unreadable';
    /** True when the layer-three figures are what the host would do, not what it did. */
    readonly settlementProjection: boolean;
  };
  readonly coverage: CoverageSummary;
  readonly behaviour: BehaviourSection;
  readonly diagnostics: DiagnosticsSection;
  readonly settlement: SettlementSection;
  readonly usage: UsageSection;
  readonly stability: StabilitySection;
  readonly efficiency: EfficiencySection;
  readonly comparison: ComparisonSection;
  readonly examples: readonly CellView[];
  readonly differences: readonly DifferenceRow[];
  readonly checks: readonly ReportCheck[];
  readonly notes: readonly string[];
}
