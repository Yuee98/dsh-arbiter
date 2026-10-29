/**
 * One planned cell, with everything the report knows about it joined together.
 *
 * A cell is the report's unit because it is the artifact's unit: one case, one
 * target, one protocol, one repeat. The join is what lets the three layers agree
 * with each other and with the per-example evidence — every figure in the summary
 * is a fold over this one list, so a reader can trace any number back to the cells
 * that produced it.
 *
 * Four inputs meet here and each is authoritative for a different fact:
 *
 *   index      which cells the run planned, and which of them it never started
 *   record     what actually happened to a dispatched cell
 *   dataset    the case's family, split, provenance and mechanisms
 *   label      what the user decided the call should reach
 *
 * A cell with no record is not an error by itself. The index distinguishes a cell
 * that was refused before dispatch from one that claims to have run, and only the
 * second is a gap — so the difference is carried into the row rather than guessed
 * from an absent file.
 */

import type {
  BehaviourClass,
  EngineAnswer,
  EngineWord,
  ReferenceWord,
} from './types.js';
import { challengeClassOf, recordInputHash } from './observe.js';
import type {
  CaseFacts,
  DatasetFacts,
  LabelFacts,
  Observation,
} from './observe.js';
import type { CellRecord, CellState, RunProtocol } from '../run/types.js';
import { aggregateUsage } from '../../../src/reviewer/usage.js';
import type { UsageAttempt, UsageField } from '../../../src/reviewer/usage.js';
import { usageAttemptsOf } from '../run/artifact.js';

/** Which of the artifact's states a cell is in, as a report needs to state it. */
export type CellStanding =
  /** A record exists and the cell produced an outcome. */
  | 'answered'
  /** A record exists but the cell produced no outcome: a transport failure, a timeout, a cancellation. */
  | 'no-outcome'
  /** The index claims the cell was dispatched, but no record exists. */
  | 'missing-record'
  /** The cell was decided before dispatch: unsupported, out of budget, unresolvable, never started. */
  | 'not-run';

/** One planned cell, joined with its record, its dataset facts and its label. */
export interface CellFacts {
  readonly cellId: string;
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: RunProtocol;
  readonly repeat: number;
  /** The status the index recorded, which is the settled state a re-run would read. */
  readonly indexStatus: CellState['status'];
  readonly standing: CellStanding;
  readonly record: CellRecord | null;
  /** The input hash the run submitted, or null when the cell never produced a record. */
  readonly inputHash: string | null;
  /**
   * The model this cell ran, as the record declared it.
   *
   * Taken from the record rather than from the plan: a record's target block names what
   * actually answered, and the plan only names what was asked for. A cell with no record
   * therefore has no model here, which is the honest state — the index knows the target
   * id but not what it resolved to.
   */
  readonly model: {
    readonly provider: string;
    readonly configured: string;
    readonly version: string | null;
    /** The model the response body named, when it named one. */
    readonly reported: string | null;
  } | null;
  /** `provider/configured model`, or the empty string when the cell produced no record. */
  readonly modelKey: string;
  /** The dataset's view of the case, or null when the dataset did not publish it. */
  readonly caseFacts: {
    readonly familyId: string;
    readonly split: string;
    readonly provenance: string;
    /** Dataset-relative path of the case document, or null when the dataset lacks it. */
    readonly path: string | null;
    /**
     * The mechanisms the input uses, or null when they cannot be attributed to this run.
     *
     * Null means either that the dataset did not supply the case, or that its input has
     * changed since the run: in both states the mechanisms belong to material the reviewer
     * never saw, so the classification is `unclassified` rather than a guess.
     */
    readonly challenge: readonly string[] | null;
    /** Whether the challenge mechanisms were read from the input this run submitted. */
    readonly challengeVerified: boolean;
    /** Which input supplied these figures. */
    readonly source: 'record' | 'dataset' | 'record-and-dataset';
    /** Whether the dataset has since been reorganised away from what the run recorded. */
    readonly conflictsWithDataset: boolean;
  } | null;
  readonly challengeClass: 'ordinary' | 'targeted' | 'unclassified';
  readonly label: LabelFacts | null;
  readonly engine: EngineAnswer;
  /**
   * The reference, only when the label actually adjudicated this cell's input.
   *
   * A label is approved against an input fingerprint, and a run records the fingerprint it
   * submitted. Joining them by case id alone would let a label for a newer input become the
   * reference for an older answer — which is a comparison nobody made, reported as a
   * measured one. So the comparison is gated on the two fingerprints agreeing, and a
   * mismatch is its own label status rather than a silent exclusion.
   */
  readonly reference: ReferenceWord | null;
  readonly labelStatus:
    | 'gold'
    | 'missing'
    | 'excluded'
    | 'case-absent'
    | 'input-mismatch'
    | 'authority-conflict';
  readonly labelReasons: readonly string[];
  /** What the engine said, as a word, or null when it said nothing. */
  readonly engineWord: EngineWord | null;
  /** Whether this cell's answer is a statement about the reviewed call. */
  readonly judged: boolean;
  /** How long the cell took, from the record's own timing; zero when it never ran. */
  readonly durationMs: number;
  /** The six usage buckets the record summarized, or null per bucket when unknown. */
  readonly tokens: Readonly<Record<UsageField, number | null>>;
  /** Cost as a status, because the runner never prices a token. */
  readonly costStatus: 'not-computed' | 'not-applicable' | null;
  /** The cost reason the record gave, copied rather than paraphrased. */
  readonly costReason: string | null;
}

/** The protocol word of a verdict, which is also the behaviour it asks for. */
function wordOfVerdict(verdict: string): EngineWord | null {
  switch (verdict) {
    case 'review-allow':
      return 'allow';
    case 'review-deny':
      return 'deny';
    case 'review-escalate':
      return 'escalate';
    default:
      // A verdict outside the shared three is not something this report invents a
      // meaning for. It stays unread and is reported as such.
      return null;
  }
}

/**
 * What a record says the engine answered.
 *
 * The three outcomes are read as three different words rather than collapsed: a
 * review that failed and a review that found the material insufficient are not
 * answers about the call, and treating either as a denial is exactly the mistake
 * this report exists to prevent.
 */
export function engineAnswerOf(record: CellRecord | null): EngineAnswer {
  if (record === null) {
    return {
      word: null,
      verdict: null,
      risk: null,
      authorization: null,
      requiredAuthorization: null,
      reason: null,
    };
  }
  const outcome = record.outcome;
  if (outcome === null) {
    return {
      word: null,
      verdict: null,
      risk: null,
      authorization: null,
      requiredAuthorization: null,
      reason: record.stopReason,
    };
  }
  if (outcome.status === 'scored') {
    return {
      word: wordOfVerdict(outcome.verdict),
      verdict: outcome.verdict,
      risk: outcome.risk,
      authorization: outcome.authorization,
      requiredAuthorization: outcome.requiredAuthorization,
      reason: null,
    };
  }
  if (outcome.status === 'insufficient-material') {
    return {
      word: 'insufficient-material',
      verdict: null,
      risk: null,
      authorization: null,
      requiredAuthorization: null,
      reason: outcome.reason,
    };
  }
  return {
    word: 'review-failure',
    verdict: null,
    risk: null,
    authorization: null,
    requiredAuthorization: null,
    reason: outcome.reason,
  };
}

/** Where a planned cell sits in the artifact's own state machine. */
export function standingOf(
  state: CellState,
  record: CellRecord | null,
): CellStanding {
  if (record !== null) {
    return record.outcome === null ? 'no-outcome' : 'answered';
  }
  // A dispatched status with no record is the one genuine gap: the run says it ran,
  // and the directory holds no evidence of what it produced.
  return isRecordless(state.status) ? 'not-run' : 'missing-record';
}

/** Whether this settled status is a decision made before any request was sent. */
function isRecordless(status: CellState['status']): boolean {
  return (
    status === 'unsupported' ||
    status === 'budget-exhausted' ||
    status === 'unresolvable' ||
    status === 'not-run'
  );
}

/**
 * The label standing of one cell, from the dataset's assessment and its own fingerprint.
 *
 * The two fingerprints are compared here rather than trusted: `label.inputHash` was recorded
 * when the adjudicator decided, and `cellInputHash` is what this run actually submitted. A
 * disagreement means the label judges material this cell never saw.
 *
 * `authority-conflict` is the third state: two adjudications claim the same case, or the
 * dataset's own inspection found the label incoherent. Neither can become a reference,
 * because neither establishes which decision a human made.
 */
function labelStatusOf(parts: {
  readonly label: LabelFacts | null;
  readonly caseKnown: boolean;
  readonly cellInputHash: string | null;
  readonly conflicted: boolean;
}): CellFacts['labelStatus'] {
  if (!parts.caseKnown) return 'case-absent';
  if (parts.label === null) return 'missing';
  if (parts.conflicted) return 'authority-conflict';
  if (!parts.label.gold) return 'excluded';
  if (
    parts.cellInputHash !== null &&
    parts.label.label.inputHash !== parts.cellInputHash
  ) {
    return 'input-mismatch';
  }
  return 'gold';
}

/** The reference a gold label records, or null when there is none to compare against. */
function referenceOf(
  label: LabelFacts | null,
  status: CellFacts['labelStatus'],
): ReferenceWord | null {
  if (label === null || status !== 'gold') return null;
  const recorded = label.label.target.behaviourReference;
  return recorded === null ? null : recorded;
}

/**
 * Whether an outcome is a statement about the reviewed call.
 *
 * A scored review and an insufficiency report both say something about the call. A
 * review failure says something about the reviewer, which is a different subject
 * and belongs outside the denominator a quality metric is computed over.
 */
function isJudged(engine: EngineAnswer): boolean {
  return engine.word !== null && engine.word !== 'review-failure';
}

/** One record's sent attempts, as the shared aggregate takes them. */
function attempts(record: CellRecord): readonly UsageAttempt[] {
  return usageAttemptsOf(record);
}

/** The model a record's target block names, or null when there is no record. */
function modelOf(record: CellRecord | null): CellFacts['model'] {
  if (record === null) return null;
  return {
    provider: record.target.provider,
    configured: record.target.configuredModel,
    version: record.target.modelVersion,
    reported: record.target.responseModel,
  };
}

/**
 * The key a table groups models by.
 *
 * `provider/configured model`, because those are the two facts the plan declared and the
 * run can be repeated with. A response-reported model name is deliberately not part of
 * the key: a provider that renames a route between runs would otherwise split one row into
 * two and hide the comparison.
 *
 * A cell with no record has no model to report. It is not given the target id: a target id
 * is an experiment label, and putting it in a model column would make an unexecuted cell
 * look like a model that ran.
 */
function modelKeyOf(record: CellRecord | null): string {
  if (record === null) return '';
  return `${record.target.provider}/${record.target.configuredModel}`;
}

/**
 * The six buckets a record's attempts add up to, or null per bucket.
 *
 * Recomputed from the attempts rather than copied from the record's stored summary, for the
 * same reason `byCell.aggregate` is: one authoritative figure per cell. Copying the stored
 * value here would let the example table publish a number the report's own reconciliation
 * says is wrong, which is precisely the inconsistency the reconciliation exists to catch.
 */
function tokensOf(
  record: CellRecord | null,
): Readonly<Record<UsageField, number | null>> {
  const totals =
    record === null
      ? null
      : attempts(record).length === 0
        ? null
        : aggregateUsage(attempts(record)).totals;
  const value = (field: UsageField): number | null =>
    totals === null ? null : totals[field].total;
  return {
    inputTokens: value('inputTokens'),
    outputTokens: value('outputTokens'),
    totalTokens: value('totalTokens'),
    cacheReadTokens: value('cacheReadTokens'),
    cacheWriteTokens: value('cacheWriteTokens'),
    reasoningTokens: value('reasoningTokens'),
  };
}

/**
 * The case metadata a cell is grouped by.
 *
 * The saved record is authoritative for a cell that actually ran: it recorded the family,
 * split and provenance at execution time, and those are what the run was. Reorganising the
 * dataset afterwards must not move an old run into a new family, so the dataset fills in
 * only what the record could not say — which is the whole of a cell that never ran, and the
 * challenge mechanisms, which the record never carried.
 *
 * `source` states which of the two supplied each figure, so a reader can tell an execution
 * fact from a present-day one.
 */
function caseFactsOf(parts: {
  readonly record: CellRecord | null;
  readonly datasetCase: CaseFacts | null;
  readonly cellInputHash: string | null;
}): CellFacts['caseFacts'] {
  const recorded = parts.record?.case ?? null;
  const datasetCase = parts.datasetCase;
  if (recorded === null && datasetCase === null) return null;
  // The mechanisms are read from the input the dataset holds *now*, so they describe the
  // input this run submitted only when the two fingerprints agree. A case whose input gained
  // a hint after the run would otherwise move from ordinary to targeted without a single
  // executed cell changing — a silent reclassification of history.
  const mechanismsCurrent =
    datasetCase !== null &&
    (parts.cellInputHash === null ||
      datasetCase.inputHash === parts.cellInputHash);
  return {
    familyId: recorded?.familyId ?? datasetCase?.familyId ?? 'unknown',
    split: recorded?.split ?? datasetCase?.split ?? 'unknown',
    provenance:
      recorded?.provenanceSource ?? datasetCase?.provenance ?? 'unknown',
    path: datasetCase?.path ?? null,
    challenge: mechanismsCurrent ? datasetCase.challenge : null,
    challengeVerified: mechanismsCurrent,
    source:
      recorded !== null && datasetCase !== null
        ? 'record-and-dataset'
        : recorded !== null
          ? 'record'
          : 'dataset',
    // A conflict is a dataset that has since been reorganized or re-edited. It is reported
    // rather than resolved: the grouping follows the record, and the reader is told the two
    // disagree.
    conflictsWithDataset:
      datasetCase !== null &&
      ((recorded !== null &&
        (recorded.familyId !== datasetCase.familyId ||
          recorded.split !== datasetCase.split ||
          recorded.provenanceSource !== datasetCase.provenance)) ||
        !mechanismsCurrent),
  };
}

/** Join one planned cell with its record, its dataset facts and its label. */
export function cellFactsOf(parts: {
  readonly state: CellState;
  readonly record: CellRecord | null;
  readonly dataset: DatasetFacts;
}): CellFacts {
  const facts = parts.dataset.cases.get(parts.state.caseId) ?? null;
  const label = parts.dataset.labels.get(parts.state.caseId) ?? null;
  const engine = engineAnswerOf(parts.record);
  const inputHash =
    parts.record === null ? null : recordInputHash(parts.record);
  const caseFacts = caseFactsOf({
    record: parts.record,
    datasetCase: facts,
    cellInputHash: inputHash,
  });
  const labelStatus = labelStatusOf({
    label,
    caseKnown: facts !== null,
    cellInputHash: inputHash,
    conflicted: parts.dataset.contestedCases.has(parts.state.caseId),
  });
  return {
    cellId: parts.state.cellId,
    caseId: parts.state.caseId,
    targetId: parts.state.targetId,
    protocol: parts.state.protocol,
    repeat: parts.state.repeat,
    indexStatus: parts.state.status,
    standing: standingOf(parts.state, parts.record),
    record: parts.record,
    inputHash,
    model: modelOf(parts.record),
    modelKey: modelKeyOf(parts.record),
    caseFacts: caseFacts,
    // Read from the joined facts, not from the dataset directly: when the mechanisms cannot be
    // attributed to this run the joined value is null, and the honest class is `unclassified`
    // rather than one inferred from material the reviewer never saw.
    challengeClass: challengeClassOf(caseFacts?.challenge ?? null),
    label,
    engine,
    reference: referenceOf(label, labelStatus),
    labelStatus,
    labelReasons: label === null ? [] : [...label.reasons],
    engineWord: engine.word,
    judged: isJudged(engine),
    durationMs: parts.record?.timing.durationMs ?? 0,
    tokens: tokensOf(parts.record),
    costStatus: parts.record?.cost.status ?? null,
    costReason: parts.record?.cost.reason ?? null,
  };
}

/**
 * Every planned cell, in the index's own order.
 *
 * A record the index does not plan is not invented into a cell here: it is reported
 * as a stray by the observation, because a cell nobody planned has no case
 * selection, no target declaration and no repeat index to compare against.
 */
export function cellFactsOfRun(observation: Observation): readonly CellFacts[] {
  return observation.artifact.index.cells.map((state) =>
    cellFactsOf({
      state,
      record: observation.records.get(state.cellId) ?? null,
      dataset: observation.dataset,
    }),
  );
}

/**
 * Whether this cell's label may be used as a gold reference.
 *
 * The single predicate every gold-dependent metric consults. `cell.labelStatus` is where the
 * cross-artifact checks already landed — the label was approved, it was not contested, and it
 * judges the same input this cell submitted — so re-deriving eligibility from
 * `cell.label.gold` anywhere else would reintroduce exactly the defect that status exists to
 * prevent: the dataset's own view is about the dataset, not about this run.
 *
 * Layer one, both diagnostic fields, allowed-pair counting, monotonicity, the reference
 * distribution and the score differences all call this, so the layers cannot disagree about
 * which cells they measured.
 */
export function hasGoldReference(cell: CellFacts): boolean {
  return cell.labelStatus === 'gold' && cell.reference !== null;
}

/** The behaviour classes a classification can produce, as a value for counting. */
export function classOf(
  cell: CellFacts,
  classify: (parts: {
    readonly engine: EngineWord | null;
    readonly reference: ReferenceWord | null;
    readonly standing: CellStanding;
  }) => BehaviourClass,
): BehaviourClass {
  return classify({
    engine: cell.engineWord,
    reference: cell.reference,
    standing: cell.standing,
  });
}
