/** New denominator views over the existing classifier and diagnostic core. */
import type { AskPolicy } from '../../../src/review-contract/index.js';
import { classifyCell, countsOf } from './behaviour.js';
import type { CellFacts } from './cell.js';
import { fieldErrorStats, pairStats } from './diagnostics.js';
import { referenceOfCell } from './references.js';
import { settlementOf } from './settlement.js';
import { firstConditions, sourceOf, viewKeyOf } from './source.js';
import { compareText, groupBy, rate, tally } from './support.js';
import type { BehaviourClass, BehaviourWord } from './types.js';
import type {
  BurdenSummary,
  ConditionalQuality,
  Fraction,
  QualityPopulation,
  QualitySection,
} from './quality-types.js';

const BEHAVIOURS: readonly BehaviourWord[] = ['allow', 'deny', 'escalate'];
function isBehaviour(value: string | null): value is BehaviourWord {
  return BEHAVIOURS.some((word) => word === value);
}
export function fractionOf(numerator: number, denominator: number): Fraction {
  return { numerator, denominator, rate: rate(numerator, denominator) };
}
function conditionalQuality(cells: readonly CellFacts[]): ConditionalQuality {
  const compared = cells.filter(
    (cell) =>
      cell.standing === 'answered' &&
      isBehaviour(cell.reference) &&
      isBehaviour(cell.engineWord),
  );
  const from = (references: readonly BehaviourWord[]) =>
    compared.filter((cell) =>
      references.some((word) => word === cell.reference),
    );
  const measured = (
    population: readonly CellFacts[],
    classification: BehaviourClass,
  ): Fraction =>
    fractionOf(
      population.filter((cell) => classifyCell(cell) === classification).length,
      population.length,
    );
  return {
    falseAllow: measured(from(['deny', 'escalate']), 'false-allow'),
    falseDeny: measured(from(['allow', 'escalate']), 'false-deny'),
    falseDenyFromAllow: measured(from(['allow']), 'false-deny'),
    falseDenyFromEscalate: measured(from(['escalate']), 'false-deny'),
    unnecessaryHuman: measured(from(['allow']), 'unnecessary-human'),
    unnecessaryHumanOfCompared: measured(
      cells.filter(
        (cell) =>
          cell.judged &&
          cell.reference !== null &&
          cell.standing === 'answered',
      ),
      'unnecessary-human',
    ),
    escalateNotDeny: measured(from(['deny']), 'escalate-not-deny'),
    confusion: BEHAVIOURS.flatMap((reference) =>
      BEHAVIOURS.map((actual) => ({
        reference,
        actual,
        count: compared.filter(
          (cell) => cell.reference === reference && cell.engineWord === actual,
        ).length,
      })),
    ),
  };
}
function burdenOf(
  cells: readonly CellFacts[],
  settings: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
  },
): BurdenSummary {
  const applicable = cells.filter((cell) => cell.reference === 'allow');
  const supported = applicable.filter(
    (cell) => cell.indexStatus !== 'unsupported',
  );
  const projected: string[] = [];
  let preDispatchBlocked = 0,
    unknown = 0;
  for (const cell of supported) {
    if (
      cell.indexStatus === 'budget-exhausted' ||
      cell.indexStatus === 'unresolvable'
    ) {
      preDispatchBlocked += 1;
    } else if (
      cell.engineWord === null ||
      cell.standing === 'missing-record' ||
      cell.standing === 'not-run'
    ) {
      unknown += 1;
    } else projected.push(settlementOf({ cell, ...settings }));
  }
  const known =
    projected.filter(
      (kind) =>
        kind === 'ask-human' || kind === 'fallback-deny' || kind === 'deny',
    ).length + preDispatchBlocked;
  return {
    evidence: 'projected-review-and-recorded-dispatch',
    plannedAllow: applicable.length,
    supportedAllow: supported.length,
    projected: tally(projected),
    preDispatchBlocked,
    unsupported: applicable.length - supported.length,
    unknown,
    knownBurdenLowerBound: fractionOf(known, applicable.length),
    supportedBurdenLowerBound: fractionOf(known, supported.length),
    actualContinuation: 'not-observed',
  };
}
function populationOf(
  cells: readonly CellFacts[],
  settings: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
  },
): QualityPopulation {
  const conditions = firstConditions(cells);
  const shouldRequest = conditions.filter(
    (cell) =>
      cell.indexStatus !== 'unsupported' &&
      !(
        cell.record?.material?.completenessStatus === 'insufficient' &&
        cell.record.attempts.length === 0 &&
        cell.record.abandonment === null &&
        cell.engineWord === 'insufficient-material'
      ),
  );
  const expectedM0 = conditions.filter(
    (cell) => cell.reference === 'insufficient-material',
  );
  const noDispatch = expectedM0.filter((cell) =>
    cell.record !== null
      ? cell.record.abandonment === null &&
        cell.record.attempts.every((attempt) => attempt.sent === false)
      : ['unsupported', 'budget-exhausted', 'unresolvable'].includes(
          cell.indexStatus,
        ),
  ).length;
  const sentM0 = expectedM0.filter(
    (cell) =>
      cell.record?.attempts.some((attempt) => attempt.sent !== false) === true,
  ).length;
  return {
    cells: countsOf(cells),
    conditions: countsOf(conditions),
    conditional: conditionalQuality(conditions),
    burden: burdenOf(conditions, settings),
    cellBurden: burdenOf(cells, settings),
    risk: fieldErrorStats(cells, 'risk'),
    authorization: fieldErrorStats(cells, 'authorization'),
    pairs: pairStats(cells),
    statuses: tally(cells.map((cell) => cell.indexStatus)),
    failureKinds: tally(
      cells.flatMap(
        (cell) =>
          cell.record?.attempts.flatMap((attempt) =>
            attempt.failureKind === null ? [] : [attempt.failureKind],
          ) ?? [],
      ),
    ),
    technicalAvailability: fractionOf(
      shouldRequest.filter(
        (cell) => isBehaviour(cell.engineWord) && cell.standing === 'answered',
      ).length,
      shouldRequest.length,
    ),
    reviewFailure: {
      expected: conditions.filter((cell) => cell.reference === 'review-failure')
        .length,
      observed: conditions.filter(
        (cell) => cell.engineWord === 'review-failure',
      ).length,
      matched: conditions.filter(
        (cell) =>
          cell.reference === 'review-failure' &&
          cell.engineWord === 'review-failure',
      ).length,
    },
    m0: {
      knownNoDispatch: noDispatch,
      unexpectedDispatch: sentM0,
      unknownDispatch: expectedM0.length - noDispatch - sentM0,
      expected: conditions.filter(
        (cell) => cell.reference === 'insufficient-material',
      ).length,
      observed: conditions.filter(
        (cell) => cell.engineWord === 'insufficient-material',
      ).length,
      matched: conditions.filter(
        (cell) =>
          cell.reference === 'insufficient-material' &&
          cell.engineWord === 'insufficient-material',
      ).length,
    },
  };
}
function identitiesOf(
  cells: readonly CellFacts[],
): QualitySection['identities'] {
  const workflow = cells.flatMap((cell) => {
    const source = sourceOf(cell);
    return source.kind === 'workflow' ? [source] : [];
  });
  const size = (values: readonly string[]) => new Set(values).size;
  return {
    legacyCases: size(
      cells.flatMap((cell) => {
        const source = sourceOf(cell);
        return source.kind === 'legacy' ? [source.caseId] : [];
      }),
    ),
    roots: size(workflow.map((source) => source.rootId)),
    lineages: size(workflow.map((source) => source.lineageId)),
    points: size(
      workflow.map((source) => JSON.stringify([source.rootId, source.pointId])),
    ),
    views: size(
      workflow.map((source) =>
        JSON.stringify([source.rootId, source.pointId, source.viewId]),
      ),
    ),
    primaryViews: size(
      workflow
        .filter((source) => source.primaryView)
        .map((source) =>
          JSON.stringify([source.rootId, source.pointId, source.viewId]),
        ),
    ),
    diagnosticViews: size(
      workflow
        .filter((source) => !source.primaryView)
        .map((source) =>
          JSON.stringify([source.rootId, source.pointId, source.viewId]),
        ),
    ),
    repeatCells: cells.filter((cell) => cell.repeat > 1).length,
    attempts: cells.reduce(
      (total, cell) => total + (cell.record?.attempts.length ?? 0),
      0,
    ),
  };
}
function referenceCoverage(
  cells: readonly CellFacts[],
): QualitySection['references'] {
  const units = new Map<string, CellFacts>();
  for (const cell of cells) {
    const reference = referenceOfCell(cell);
    const binding = reference.binding;
    const key = JSON.stringify([
      viewKeyOf(cell),
      cell.protocol,
      binding?.promptFingerprint,
      binding?.versions.contract,
      binding?.versions.rubric,
      binding?.versions.policy,
      binding?.credentials === true ? binding.inputHash : null,
      reference.source,
    ]);
    if (!units.has(key)) units.set(key, cell);
  }
  const entries = [...units.values()];
  return {
    cellsBySource: tally(cells.map((cell) => referenceOfCell(cell).source)),
    unitsBySource: tally(entries.map((cell) => referenceOfCell(cell).source)),
    consensus: entries.flatMap((cell) => {
      const consensus = referenceOfCell(cell).consensus;
      return consensus === null
        ? []
        : [
            {
              view: viewKeyOf(cell),
              protocol: cell.protocol,
              n: consensus.n,
              k: consensus.k,
              branch: consensus.branch,
              returned: consensus.returned,
              valid: consensus.valid,
              missing: consensus.missing,
              failed: consensus.failed,
            },
          ];
    }),
  };
}
export function qualitySection(
  cells: readonly CellFacts[],
  settings: {
    readonly mode: AskPolicy;
    readonly channel: 'available' | 'unavailable';
  },
): QualitySection {
  const axes: readonly {
    readonly axis: QualitySection['byGroup'][number]['axis'];
    readonly key: (cell: CellFacts) => string;
  }[] = [
    {
      axis: 'content-set',
      key: (cell) =>
        sourceOf(cell).kind === 'legacy' ? 'legacy-v1' : 'workflows-v1',
    },
    { axis: 'reference-source', key: (cell) => referenceOfCell(cell).source },
    {
      axis: 'split',
      key: (cell) => {
        const source = sourceOf(cell);
        return source.kind === 'workflow'
          ? source.split
          : (cell.caseFacts?.split ?? 'unknown');
      },
    },
    {
      axis: 'business',
      key: (cell) => {
        const source = sourceOf(cell);
        return source.kind === 'workflow' ? source.group : 'legacy-v1';
      },
    },
    { axis: 'target', key: (cell) => cell.targetId },
    { axis: 'protocol', key: (cell) => cell.protocol },
  ];
  return {
    conditionSelection: 'lowest-planned-repeat',
    overall: populationOf(cells, settings),
    byGroup: axes.flatMap(({ axis, key }) =>
      [...groupBy(cells, key).entries()]
        .sort(([a], [b]) => compareText(a, b))
        .map(([value, group]) => ({
          axis,
          key: value,
          population: populationOf(group, settings),
        })),
    ),
    identities: identitiesOf(cells),
    references: referenceCoverage(cells),
  };
}
