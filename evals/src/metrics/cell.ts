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
import type { DatasetFacts, LabelFacts, Observation } from './observe.js';
import type { CellRecord, CellState, RunProtocol } from '../run/types.js';
import type { UsageField } from '../../../src/reviewer/usage.js';

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
    readonly path: string;
    readonly challenge: readonly string[];
  } | null;
  readonly challengeClass: 'ordinary' | 'targeted' | 'unclassified';
  readonly label: LabelFacts | null;
  readonly engine: EngineAnswer;
  readonly reference: ReferenceWord | null;
  readonly labelStatus: 'gold' | 'missing' | 'excluded' | 'case-absent';
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

/** The label standing of one case, from the dataset's own assessment. */
function labelStatusOf(
  label: LabelFacts | null,
  caseKnown: boolean,
): 'gold' | 'missing' | 'excluded' | 'case-absent' {
  if (!caseKnown) return 'case-absent';
  if (label === null) return 'missing';
  return label.gold ? 'gold' : 'excluded';
}

/** The reference a gold label records, or null when there is none to compare against. */
function referenceOf(label: LabelFacts | null): ReferenceWord | null {
  if (label === null || !label.gold) return null;
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

/** The six buckets a record's summary reported, or null per bucket. */
function tokensOf(
  record: CellRecord | null,
): Readonly<Record<UsageField, number | null>> {
  const totals = record?.usage?.totals;
  const value = (field: UsageField): number | null =>
    totals === undefined ? null : totals[field].total;
  return {
    inputTokens: value('inputTokens'),
    outputTokens: value('outputTokens'),
    totalTokens: value('totalTokens'),
    cacheReadTokens: value('cacheReadTokens'),
    cacheWriteTokens: value('cacheWriteTokens'),
    reasoningTokens: value('reasoningTokens'),
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
  return {
    cellId: parts.state.cellId,
    caseId: parts.state.caseId,
    targetId: parts.state.targetId,
    protocol: parts.state.protocol,
    repeat: parts.state.repeat,
    indexStatus: parts.state.status,
    standing: standingOf(parts.state, parts.record),
    record: parts.record,
    inputHash: parts.record === null ? null : recordInputHash(parts.record),
    model: modelOf(parts.record),
    modelKey: modelKeyOf(parts.record),
    caseFacts:
      facts === null
        ? null
        : {
            familyId: facts.familyId,
            split: facts.split,
            provenance: facts.provenance,
            path: facts.path,
            challenge: facts.challenge,
          },
    challengeClass: challengeClassOf(facts?.challenge ?? null),
    label,
    engine,
    reference: referenceOf(label),
    labelStatus: labelStatusOf(label, facts !== null),
    labelReasons: label?.reasons ?? [],
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
