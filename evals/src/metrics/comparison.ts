/**
 * What may be compared with what, and what must be reported as a whole instead.
 *
 * The milestone's rule is narrow and easy to get wrong: two protocols of *the same
 * model* may be compared when both were genuinely supported, and when a comparison
 * changes the model and the protocol at once it describes a system combination rather
 * than the effect of a protocol.
 *
 * The reason is causal. A chat call to model X and a decision call to model Y differ in
 * two things, so any difference between them is attributable to neither. Calling that a
 * protocol comparison would be the most common way an evaluation reports a conclusion it
 * cannot support, so this module refuses to construct one and emits a system
 * combination with the reason attached.
 *
 * The same caution applies inside one target: two protocols of the same model are
 * comparable only on the cases both actually answered. A protocol that failed on a case
 * has no answer to compare, and imputing one — from the other protocol, or from a
 * threshold — would manufacture the agreement being measured.
 */

import type { CellFacts } from './cell.js';
import { compareText, distinct, groupBy, rate } from './support.js';
import type {
  ComparisonSection,
  ProtocolComparison,
  SystemCombination,
} from './types.js';

/** One case's answer under one protocol. */
interface ProtocolAnswer {
  readonly risk: number;
  readonly authorization: number;
  readonly behaviour: string;
}

/** The answer one cell gave, or null when it gave none. */
function answerOf(cell: CellFacts): ProtocolAnswer | null {
  const risk = cell.engine.risk;
  const authorization = cell.engine.authorization;
  const behaviour = cell.engineWord;
  if (risk === null || authorization === null || behaviour === null)
    return null;
  return { risk, authorization, behaviour };
}

/**
 * One protocol's answer per case, keeping the lowest repeat.
 *
 * The choice of repeat is stated rather than left to iteration order: a comparison over
 * paired cases must be one value per case, and picking the first repeat by index makes
 * the result reproducible from the same artifact.
 */
function answersByCase(
  cells: readonly CellFacts[],
): ReadonlyMap<string, ProtocolAnswer> {
  const answers = new Map<string, ProtocolAnswer>();
  const ordered = cells
    .filter(executed)
    .sort(
      (left, right) =>
        compareText(left.caseId, right.caseId) || left.repeat - right.repeat,
    );
  for (const cell of ordered) {
    const answer = answerOf(cell);
    if (answer === null || answers.has(cell.caseId)) continue;
    answers.set(cell.caseId, answer);
  }
  return answers;
}

/**
 * The cases two protocols of one target both answered.
 *
 * The intersection is taken on case id, not on cell id, because repeats would otherwise
 * multiply the comparison: one case answered four times under each protocol is one case,
 * and comparing twelve cells would report agreement over twelve when there is one.
 */
function pairedCases(
  chat: readonly CellFacts[],
  decision: readonly CellFacts[],
): readonly {
  readonly caseId: string;
  readonly chat: ProtocolAnswer;
  readonly decision: ProtocolAnswer;
}[] {
  const chatByCase = answersByCase(chat);
  const decisionByCase = answersByCase(decision);
  return [...chatByCase.keys()]
    .filter((caseId) => decisionByCase.has(caseId))
    .sort(compareText)
    .flatMap((caseId) => {
      const left = chatByCase.get(caseId);
      const right = decisionByCase.get(caseId);
      return left === undefined || right === undefined
        ? []
        : [{ caseId, chat: left, decision: right }];
    });
}

/**
 * One target's dual-protocol comparison.
 *
 * `basis` names why the comparison is legal, so a reader does not have to reconstruct
 * it: both protocols belong to one target, which means one model and one set of
 * connection settings. The case count and the paired count are both published, because
 * a comparison over eight of thirty cases is a much weaker claim than over thirty, and
 * only a reader who sees both denominators can tell them apart.
 */
function comparisonOf(
  targetId: string,
  model: string,
  chat: readonly CellFacts[],
  decision: readonly CellFacts[],
): ProtocolComparison {
  const pairs = pairedCases(chat, decision);
  const behaviourAgree = pairs.filter(
    (pair) => pair.chat.behaviour === pair.decision.behaviour,
  ).length;
  const scoreAgree = pairs.filter(
    (pair) =>
      pair.chat.risk === pair.decision.risk &&
      pair.chat.authorization === pair.decision.authorization,
  ).length;
  return {
    targetId,
    model,
    basis: 'one-target-two-protocols',
    cases: distinct([
      ...chat.map((cell) => cell.caseId),
      ...decision.map((cell) => cell.caseId),
    ]).length,
    paired: pairs.length,
    behaviourAgree,
    scoreAgree,
    differences: pairs
      .filter(
        (pair) =>
          pair.chat.risk !== pair.decision.risk ||
          pair.chat.authorization !== pair.decision.authorization,
      )
      .map((pair) => ({
        caseId: pair.caseId,
        chat: [pair.chat.risk, pair.chat.authorization] as const,
        decision: [pair.decision.risk, pair.decision.authorization] as const,
      })),
  };
}

/** One target-and-protocol group that the run actually executed. */
interface Exercised {
  readonly targetId: string;
  readonly model: string;
  readonly protocol: string;
}

/** The target-and-protocol groups a run actually executed. */
function exercisedOf(cells: readonly CellFacts[]): readonly Exercised[] {
  const groups = new Map<string, Exercised>();
  for (const cell of cells) {
    if (cell.record === null) continue;
    const key = [cell.targetId, cell.protocol].join('~');
    if (groups.has(key)) continue;
    groups.set(key, {
      targetId: cell.targetId,
      model: cell.modelKey,
      protocol: cell.protocol,
    });
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, group]) => group);
}

/**
 * Whether a cell's own record exists, which is what makes it a comparable observation.
 *
 * A cell the plan refused before dispatch has no model, no protocol response and no
 * answer. Including it in a comparison group would put it on one side of a pairing that
 * never happened, which is why every pairing function starts from this test.
 */
function executed(cell: CellFacts): boolean {
  return cell.record !== null;
}

/**
 * The combinations that differ in both dimensions.
 *
 * Reported instead of a comparison, one entry per pair. The `reason` states the confound
 * in the report's own words, so a reader cannot read a difference as a protocol effect
 * simply because two protocols appear in the same table. A pair that differs in the model
 * alone is not listed here: that is a model comparison, and it is described by the note
 * rather than dressed up as a system.
 */
function systemCombinations(
  exercised: readonly Exercised[],
): readonly SystemCombination[] {
  const systems: SystemCombination[] = [];
  for (let left = 0; left < exercised.length; left += 1) {
    for (let right = left + 1; right < exercised.length; right += 1) {
      const a = exercised[left];
      const b = exercised[right];
      if (a === undefined || b === undefined) continue;
      if (a.model === b.model || a.protocol === b.protocol) continue;
      systems.push({
        targetId: `${a.targetId} vs ${b.targetId}`,
        model: `${a.model} vs ${b.model}`,
        protocols: [a.protocol, b.protocol],
        reason:
          '这两个组合的模型与协议同时不同，因此差异只能作为系统组合报告，不能归因于单一协议。',
      });
    }
  }
  return systems;
}

/**
 * The unsupported combinations the plan declared.
 *
 * A plan can state a model/protocol pairing the model does not offer, and the runner
 * records it as `unsupported` rather than sending a request nobody could answer. The
 * report repeats it here because it is the reason a comparison is missing: without this
 * line an absent table looks like an oversight rather than a finding.
 */
function unsupportedOf(
  cells: readonly CellFacts[],
): readonly ComparisonSection['unsupported'][number][] {
  const groups = new Map<string, string[]>();
  for (const cell of cells) {
    if (cell.indexStatus !== 'unsupported') continue;
    const existing = groups.get(cell.targetId);
    if (existing === undefined) groups.set(cell.targetId, [cell.protocol]);
    else if (!existing.includes(cell.protocol)) existing.push(cell.protocol);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([targetId, protocols]) => ({
      targetId,
      protocols: [...protocols].sort(compareText),
      reason: `目标 ${targetId} 不支持 ${[...protocols].sort(compareText).join('、')}，因此这些格子从未发送请求，也没有可比较的结果。`,
    }));
}

/**
 * Build the comparison section.
 *
 * A target is compared only when it ran both protocols. A target whose protocols were
 * both declared but only one was exercised still is not compared: there is nothing on
 * the other side, and an empty comparison would sit in the table looking like agreement.
 */
export function comparisonSection(
  cells: readonly CellFacts[],
): ComparisonSection {
  const byTarget = groupBy(cells, (cell) => cell.targetId);
  const comparisons: ProtocolComparison[] = [];
  const notes: string[] = [];
  for (const [targetId, group] of [...byTarget.entries()].sort(
    ([left], [right]) => compareText(left, right),
  )) {
    const chat = group.filter((cell) => cell.protocol === 'chat');
    const decision = group.filter((cell) => cell.protocol === 'decision');
    const ranChat = chat.filter(executed);
    const ranDecision = decision.filter(executed);
    if (ranChat.length > 0 && ranDecision.length > 0) {
      const model = distinct(group.map((cell) => cell.modelKey)).join('、');
      comparisons.push(comparisonOf(targetId, model, ranChat, ranDecision));
      continue;
    }
    // A protocol that was planned but never dispatched is not a side of a comparison:
    // saying "only chat was covered" is right, and constructing an empty pairing would
    // put a comparison with no cases into the table.
    const ran = distinct(group.filter(executed).map((cell) => cell.protocol));
    if (ran.length === 1) {
      notes.push(
        `目标 ${targetId} 本次只覆盖了 ${ran[0] ?? ''}，因此没有同模型双协议比较。`,
      );
    }
  }
  const models = distinct(
    cells.filter((cell) => cell.record !== null).map((cell) => cell.modelKey),
  );
  if (models.length > 1) {
    notes.push(
      `本次运行覆盖 ${String(models.length)} 个模型（${models.join('、')}）；跨模型的差异是模型差异，不能当作协议差异。`,
    );
  }
  return {
    protocolComparisons: comparisons,
    systems: systemCombinations(exercisedOf(cells)),
    unsupported: unsupportedOf(cells),
    notes,
  };
}

/** The behaviour-agreement rate of one protocol comparison, for a caller printing one. */
export function behaviourAgreementOf(
  comparison: ProtocolComparison,
): number | null {
  return rate(comparison.behaviourAgree, comparison.paired);
}
