import type {
  BehaviourCounts,
  BehaviourWord,
  FieldErrorStats,
  PairStats,
} from './types.js';

export interface Fraction {
  readonly numerator: number;
  readonly denominator: number;
  readonly rate: number | null;
}

export interface ConditionalQuality {
  readonly falseAllow: Fraction;
  readonly falseDeny: Fraction;
  readonly falseDenyFromAllow: Fraction;
  readonly falseDenyFromEscalate: Fraction;
  readonly unnecessaryHuman: Fraction;
  readonly unnecessaryHumanOfCompared: Fraction;
  readonly escalateNotDeny: Fraction;
  readonly confusion: readonly {
    readonly reference: BehaviourWord;
    readonly actual: BehaviourWord;
    readonly count: number;
  }[];
}

export interface BurdenSummary {
  readonly evidence: 'projected-review-and-recorded-dispatch';
  readonly plannedAllow: number;
  readonly supportedAllow: number;
  readonly projected: Readonly<Record<string, number>>;
  readonly preDispatchBlocked: number;
  readonly unsupported: number;
  readonly unknown: number;
  readonly knownBurdenLowerBound: Fraction;
  readonly supportedBurdenLowerBound: Fraction;
  readonly actualContinuation: 'not-observed';
}

export interface QualityPopulation {
  readonly cells: BehaviourCounts;
  readonly conditions: BehaviourCounts;
  readonly conditional: ConditionalQuality;
  readonly burden: BurdenSummary;
  readonly risk: FieldErrorStats;
  readonly authorization: FieldErrorStats;
  readonly pairs: PairStats;
  readonly statuses: Readonly<Record<string, number>>;
  readonly failureKinds: Readonly<Record<string, number>>;
  readonly technicalAvailability: Fraction;
  readonly m0: {
    readonly expected: number;
    readonly observed: number;
    readonly matched: number;
    readonly knownNoDispatch: number;
    readonly unexpectedDispatch: number;
    readonly unknownDispatch: number;
  };
  readonly reviewFailure: {
    readonly expected: number;
    readonly observed: number;
    readonly matched: number;
  };
}

export interface QualitySection {
  readonly conditionSelection: 'lowest-planned-repeat';
  readonly overall: QualityPopulation;
  readonly byGroup: readonly {
    readonly axis:
      | 'content-set'
      | 'reference-source'
      | 'split'
      | 'business'
      | 'target'
      | 'protocol';
    readonly key: string;
    readonly population: QualityPopulation;
  }[];
  readonly identities: {
    readonly legacyCases: number;
    readonly roots: number;
    readonly lineages: number;
    readonly points: number;
    readonly views: number;
    readonly primaryViews: number;
    readonly diagnosticViews: number;
    readonly repeatCells: number;
    readonly attempts: number;
  };
  readonly references: {
    readonly cellsBySource: Readonly<Record<string, number>>;
    /** Applicability conditions, not independent views or annotation model participants. */
    readonly unitsBySource: Readonly<Record<string, number>>;
    readonly consensus: readonly {
      readonly view: string;
      readonly protocol: string;
      readonly n: number;
      readonly k: number;
      readonly branch: string | null;
      readonly returned: number;
      readonly valid: number;
      readonly missing: number;
      readonly failed: number;
    }[];
  };
}
