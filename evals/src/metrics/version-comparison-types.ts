/** Saved-run comparisons retain full populations beside their qualified intersection. */
import type { CellFacts } from './cell.js';
import type { MetricReference } from './references.js';
import type { MetricSource } from './source.js';
import type { VersionConditions } from './version-conditions.js';
import type {
  BehaviourClass,
  BehaviourCounts,
  ReportCheck,
  RunIdentity,
} from './types.js';

export type ComparisonChange = 'improved' | 'regressed' | 'unchanged';
export type ComparisonReason =
  | 'baseline-only'
  | 'current-only'
  | 'ambiguous-condition'
  | 'baseline-evidence-unverified'
  | 'current-evidence-unverified'
  | 'input-changed'
  | 'common-reference-unavailable'
  | 'common-reference-differs'
  | 'behaviour-unavailable'
  | 'scoring-unavailable';

export interface ComparisonMeasurement {
  readonly classification: BehaviourClass;
  readonly behaviour: CellFacts['engineWord'];
  readonly reference: CellFacts['reference'];
  readonly source: MetricReference['source'];
  readonly referenceId: string | null;
  readonly behaviourEligible: boolean;
  readonly scoringEligible: boolean;
  readonly pairHit: boolean | null;
  readonly risk: number | null;
  readonly authorization: number | null;
}
export interface ComparisonCell {
  readonly settings: {
    readonly evidence: 'frozen-plan-only';
    readonly temperature: number | null;
    readonly maxTokens: number | null;
    readonly timeoutMs: number | null;
    readonly reasoningEffort: string | null;
  };
  readonly cellId: string;
  readonly source: MetricSource;
  readonly targetId: string;
  readonly protocol: CellFacts['protocol'];
  readonly repeat: number;
  readonly standing: CellFacts['standing'];
  readonly indexStatus: CellFacts['indexStatus'];
  readonly model: CellFacts['model'];
  readonly inputHash: string | null;
  readonly promptFingerprint: string | null;
  readonly maxInputTokens: number | null;
  readonly targetInputTokens: number | null;
  readonly original: ComparisonMeasurement;
  readonly common: ComparisonMeasurement;
}
export interface ComparisonSide {
  readonly conditions: VersionConditions;
  readonly datasetInput: string | null;
  readonly commonDatasetInput: string | null;
  readonly run: RunIdentity;
  readonly referenceInputs: readonly string[];
  readonly commonReferenceInputs: readonly string[];
  readonly historicalReferences: 'not-established-by-saved-run';
  readonly checks: readonly ReportCheck[];
  readonly cellsPlanned: number;
  readonly conditionsPlanned: number;
  readonly statuses: Readonly<Record<string, number>>;
  readonly original: BehaviourCounts;
  readonly common: BehaviourCounts;
  readonly cells: readonly ComparisonCell[];
}
export interface ComparisonRow {
  readonly key: string;
  readonly baselineCellId: string | null;
  readonly currentCellId: string | null;
  readonly reasons: readonly ComparisonReason[];
  readonly behaviourChange: { readonly outcome: ComparisonChange } | null;
  readonly scoringChange: { readonly outcome: ComparisonChange } | null;
  readonly conditionChanges: readonly string[];
}
export interface ComparisonTransitions {
  readonly paired: number;
  readonly baselineMatched: number;
  readonly currentMatched: number;
  readonly improved: number;
  readonly regressed: number;
  readonly unchanged: number;
  readonly baselineRate: number | null;
  readonly currentRate: number | null;
}
export interface VersionComparison {
  readonly conditionSelection: 'lowest-planned-repeat';
  readonly interpretation: 'paired-system-observations';
  readonly baseline: ComparisonSide;
  readonly current: ComparisonSide;
  readonly unionConditions: number;
  readonly pairedConditions: number;
  readonly pairedPoints: number;
  readonly behaviour: ComparisonTransitions;
  readonly scoring: ComparisonTransitions;
  readonly rows: readonly ComparisonRow[];
}
