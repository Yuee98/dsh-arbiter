/**
 * Layer three: the actual mode, the human, and the host settlement.
 *
 * The distinction this layer exists to keep is between *what a review says* and *what
 * the host does with it*. Under one matrix, the same escalate becomes a human question
 * when an approval channel is reachable and a denial when it is not. So this layer
 * takes the mode and the channel as inputs and reports the settled outcome rather than
 * the review stage it came from.
 *
 * Three properties are load-bearing:
 *
 *   - the settlement rule is the shared one. `settle` from the review contract decides
 *     every branch, so a report cannot disagree with the host it is describing.
 *   - a technical failure is never counted as a prohibition. A review that failed or
 *     found its material insufficient produced no verdict, so its settlement carries a
 *     technical stage and is counted on its own line. Reporting it as `deny` would say
 *     the reviewer refused an action nobody refused.
 *   - an unnecessary human question is distinguished from a necessary one. Asking a
 *     person costs the attention this milestone is trying to protect: asking where the
 *     reference already says "allow" is a cost with no benefit, while asking where the
 *     reference says "escalate" is the design working as intended.
 */

import { settle } from '../../../src/review-contract/matrix.js';
import type {
  ApprovalChannel,
  AskPolicy,
  ReviewStage,
} from '../../../src/review-contract/matrix.js';

import type { CellFacts } from './cell.js';
import { compareText, groupBy } from './support.js';
import type {
  GroupAxis,
  SettlementCounts,
  SettlementGroup,
  SettlementKind,
  SettlementSection,
} from './types.js';

/** Whether an approval channel is reachable, from the report's own settings. */
function channelOf(status: 'available' | 'unavailable'): ApprovalChannel {
  return status === 'available'
    ? { status: 'available' }
    : { status: 'unavailable', reason: 'no approval channel is reachable' };
}

/**
 * The review stage a cell's outcome settles from.
 *
 * The two technical stages keep their own identity into the settlement, which is the
 * mechanism that stops a timeout from being reported as a refusal.
 */
export function stageOf(cell: CellFacts): ReviewStage | null {
  switch (cell.engineWord) {
    case null:
      return null;
    case 'allow':
      return 'review-allow';
    case 'deny':
      return 'review-deny';
    case 'escalate':
      return 'review-escalate';
    case 'insufficient-material':
      // Material that could not be assembled is an escalation for a person to judge,
      // not an error: the reviewer worked and reported a gap it could not close.
      return 'review-escalate';
    case 'review-failure':
      return 'error-escalate';
  }
}

/** What the host would do with one cell's review, or why it did nothing. */
export function settlementOf(parts: {
  readonly cell: CellFacts;
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
}): SettlementKind {
  const stage = stageOf(parts.cell);
  if (stage === null) return 'not-reviewed';
  const instruction = settle(
    stage,
    parts.mode,
    channelOf(parts.channel),
    'the review did not allow the action',
  );
  switch (instruction.kind) {
    case 'allow':
      return 'allow';
    case 'deny':
      return 'deny';
    case 'ask-human':
      return 'ask-human';
    case 'fallback-deny':
      return 'fallback-deny';
  }
}

/** Whether this settlement asked a person. */
function asksHuman(kind: SettlementKind): boolean {
  return kind === 'ask-human';
}

/** A running tally, so the counting loop stays one function. */
interface Tally {
  allow: number;
  deny: number;
  askHuman: number;
  fallbackDeny: number;
  notReviewed: number;
  unnecessary: number;
  necessary: number;
  unknown: number;
  technicalAskHuman: number;
  technicalFallbackDeny: number;
  technicalNotReviewed: number;
}

/** An empty tally. */
function emptyTally(): Tally {
  return {
    allow: 0,
    deny: 0,
    askHuman: 0,
    fallbackDeny: 0,
    notReviewed: 0,
    unnecessary: 0,
    necessary: 0,
    unknown: 0,
    technicalAskHuman: 0,
    technicalFallbackDeny: 0,
    technicalNotReviewed: 0,
  };
}

/** Whether this cell's stage came from a technical outcome rather than a verdict. */
function isTechnical(cell: CellFacts): boolean {
  return (
    cell.engineWord === 'review-failure' ||
    cell.engineWord === 'insufficient-material'
  );
}

/**
 * Whether a human question was necessary.
 *
 * Only a gold label can say. A question asked about a case nobody has adjudicated is
 * unknown rather than wasted, and a question that the reference already answers is the
 * attention this report is trying to account for.
 */
function classifyQuestion(
  cell: CellFacts,
): 'necessary' | 'unnecessary' | 'unknown' {
  if (cell.reference === 'escalate') return 'necessary';
  if (cell.reference === null) return 'unknown';
  return 'unnecessary';
}

/** Add one cell's settlement to a tally. */
function record(tally: Tally, cell: CellFacts, settled: SettlementKind): void {
  if (settled === 'not-reviewed') {
    tally.notReviewed += 1;
    if (isTechnical(cell)) tally.technicalNotReviewed += 1;
    return;
  }
  if (settled === 'ask-human') {
    tally.askHuman += 1;
    if (isTechnical(cell)) tally.technicalAskHuman += 1;
    else tally[classifyQuestion(cell)] += 1;
    return;
  }
  if (settled === 'fallback-deny') {
    tally.fallbackDeny += 1;
    if (isTechnical(cell)) tally.technicalFallbackDeny += 1;
    return;
  }
  if (settled === 'allow') {
    tally.allow += 1;
    return;
  }
  tally.deny += 1;
}

/** Turn a tally into the published counts. */
function countsOfTally(tally: Tally, cells: number): SettlementCounts {
  return {
    cells,
    allow: tally.allow,
    deny: tally.deny,
    askHuman: tally.askHuman,
    fallbackDeny: tally.fallbackDeny,
    notReviewed: tally.notReviewed,
    unnecessaryHuman: tally.unnecessary,
    necessaryHuman: tally.necessary,
    unknownNecessity: tally.unknown,
    technical: {
      askHuman: tally.technicalAskHuman,
      fallbackDeny: tally.technicalFallbackDeny,
      notReviewed: tally.technicalNotReviewed,
    },
  };
}

/** Count one population's settlements. */
export function settlementCountsOf(
  cells: readonly CellFacts[],
  settings: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
  },
): SettlementCounts {
  const tally = emptyTally();
  for (const cell of cells) {
    record(tally, cell, settlementOf({ cell, ...settings }));
  }
  return countsOfTally(tally, cells.length);
}

/** The axes this layer groups by, in print order. */
const AXES: readonly {
  readonly axis: GroupAxis;
  readonly keyOf: (cell: CellFacts) => string;
  readonly titleOf: (key: string) => string;
}[] = [
  {
    axis: 'challenge',
    keyOf: (cell) => cell.challengeClass,
    titleOf: (key) =>
      key === 'ordinary'
        ? '普通'
        : key === 'targeted'
          ? '定向挑战'
          : '未分类（未读到数据集）',
  },
  {
    axis: 'provenance',
    keyOf: (cell) => cell.caseFacts?.provenance ?? 'unknown',
    titleOf: (key) => key,
  },
  {
    axis: 'family',
    keyOf: (cell) => cell.caseFacts?.familyId ?? 'unknown',
    titleOf: (key) => key,
  },
  {
    axis: 'target',
    keyOf: (cell) => cell.targetId,
    titleOf: (key) => key,
  },
];

/** Every settlement group for one axis, sorted by key. */
function groupsFor(
  axis: (typeof AXES)[number],
  cells: readonly CellFacts[],
  settings: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
  },
): readonly SettlementGroup[] {
  return [...groupBy(cells, axis.keyOf).entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([key, group]) => ({
      axis: axis.axis,
      key,
      title: axis.titleOf(key),
      counts: settlementCountsOf(group, settings),
    }));
}

/**
 * Build layer three.
 *
 * `projection` is true when no cell ran through the host chain. The figures are then
 * what the shared settlement rule would instruct for these reviews, not what a host
 * observed: the runner calls the production service directly, so it has no approval
 * channel to consult. Saying so is the difference between evidence about the reviewer
 * and a claim about the host.
 */
export function settlementSection(parts: {
  readonly cells: readonly CellFacts[];
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
  readonly projection: boolean;
}): SettlementSection {
  const settings = { mode: parts.mode, channel: parts.channel };
  return {
    mode: parts.mode,
    channel: parts.channel,
    projection: parts.projection,
    overall: settlementCountsOf(parts.cells, settings),
    byGroup: AXES.flatMap((axis) => groupsFor(axis, parts.cells, settings)),
  };
}

/**
 * Whether any cell ran through the host chain.
 *
 * Only a `host-chain` entry point has a real approval channel behind it. The runner
 * assembles material from the case and calls the service directly, so a settlement
 * computed from its records is a projection by construction.
 */
export function isProjection(cells: readonly CellFacts[]): boolean {
  return !cells.some((cell) => cell.record?.entryPoint.kind === 'host-chain');
}

/**
 * The human cost of one settlement layer.
 *
 * Reported as counts plus a share over the *classified* questions, because the
 * denominator a reader wants is "of the questions asked, how many were unnecessary",
 * not "of all cells". A rate over every cell would fall as the run got quieter, which
 * is not the quantity being managed.
 */
export function humanCostOf(counts: SettlementCounts): {
  readonly asked: number;
  readonly unnecessary: number;
  readonly necessary: number;
  readonly unknown: number;
  readonly unnecessaryShare: number | null;
} {
  const classified =
    counts.necessaryHuman + counts.unnecessaryHuman + counts.unknownNecessity;
  return {
    asked: counts.askHuman,
    unnecessary: counts.unnecessaryHuman,
    necessary: counts.necessaryHuman,
    unknown: counts.unknownNecessity,
    unnecessaryShare:
      classified === 0 ? null : counts.unnecessaryHuman / classified,
  };
}

/** Whether one cell asked a person, for a caller tracing a single case. */
export function cellAsksHuman(parts: {
  readonly cell: CellFacts;
  readonly mode: AskPolicy;
  readonly channel: 'available' | 'unavailable';
}): boolean {
  return asksHuman(settlementOf(parts));
}
