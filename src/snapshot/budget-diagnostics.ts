/** Submission gaps follow selected material; calculation details stay local. */
import type {
  MaterialGapItem,
  ReviewPrefix,
  ReviewSnapshot,
} from '../types.js';
import { buildCompleteness, missingLines } from './completeness.js';
import type { CompletenessInput, MaterialTrims } from './completeness.js';
import type { BudgetUnit } from './budget-units.js';
import { prefixCompatibility } from './prefix.js';

export type UnitLog = NonNullable<ReviewSnapshot['budget']['units']>;

function trimmedUnits(units: readonly BudgetUnit[], log: UnitLog) {
  const selected = new Map(log.map((entry) => [entry.id, entry]));
  return units.filter(
    (unit) =>
      !selected.has(unit.id) || selected.get(unit.id)?.truncated === true,
  );
}

function prefixWithOmissions(
  original: ReviewPrefix | undefined,
  current: ReviewPrefix | undefined,
): ReviewPrefix | undefined {
  if (current === undefined || original === undefined) return current;
  const omissions = original.omissions.filter(
    (entry) => entry.cause !== 'budget',
  );
  for (const area of ['local', 'parent'] as const) {
    const source = original[area];
    if (source === null) continue;
    const count = source.events.length - (current[area]?.events.length ?? 0);
    if (count > 0)
      omissions.push({
        sessionId: source.status.sessionId,
        cause: 'budget',
        reason: 'Observed event units omitted by the input budget.',
        count,
      });
  }
  return { ...current, omissions };
}

function trimFlags(
  original: ReviewSnapshot,
  current: ReviewSnapshot,
  kinds: ReadonlySet<BudgetUnit['kind']>,
): MaterialTrims {
  return {
    action: current.action.truncated !== undefined,
    evidence: kinds.has('human') || kinds.has('relay'),
    toolArguments: kinds.has('tool') || kinds.has('assistant'),
    checkpoints: kinds.has('checkpoint'),
    priorVerdicts: kinds.has('prior'),
    projectRules: current.projectRules !== original.projectRules,
    derivedFacts: kinds.has('facts'),
  };
}

function extraNotes(
  original: ReviewSnapshot,
  current: ReviewSnapshot,
  kinds: ReadonlySet<BudgetUnit['kind']>,
  omitted: readonly BudgetUnit[],
): MaterialGapItem[] {
  const items: MaterialGapItem[] = [];
  if (kinds.has('reference')) {
    const sources = new Set(
      omitted.flatMap((unit) => {
        const kind = unit.evidence?.source.kind;
        return unit.kind === 'reference' &&
          (kind === 'session-human' || kind === 'parent-human')
          ? [kind]
          : [];
      }),
    );
    for (const source of sources)
      items.push({
        source,
        kind: 'truncated',
        blocking: false,
        reason:
          'Non-authorizing evidence references were omitted by the input budget.',
      });
  }
  if (current.customRules !== original.customRules)
    items.push({
      source: 'custom-rules',
      kind: 'truncated',
      blocking: false,
      reason:
        'CUSTOM_RULES was reduced by the input budget; the submitted guidance is incomplete.',
    });
  if (kinds.has('hint'))
    items.push({
      source: 'pending-action',
      kind: 'truncated',
      blocking: false,
      reason: 'The review hint was shortened or omitted by the input budget.',
    });
  return items;
}

function segmentsOf(
  flags: MaterialTrims,
  custom: boolean,
  hint: boolean,
  references: boolean,
): string[] {
  const values: readonly [boolean, string][] = [
    [flags.action, 'ACTION'],
    [flags.evidence || references, 'EVIDENCE'],
    [flags.toolArguments || flags.checkpoints, 'CONTEXT'],
    [flags.priorVerdicts, 'PRIOR_VERDICTS'],
    [flags.projectRules, 'PROJECT_RULES'],
    [custom, 'CUSTOM_RULES'],
    [flags.derivedFacts, 'DERIVED_FACTS'],
    [hint, 'HINT'],
  ];
  return values.filter(([present]) => present).map(([, name]) => name);
}

export function describeBudget(
  original: ReviewSnapshot,
  current: ReviewSnapshot,
  material: Omit<CompletenessInput, 'trimmed'>,
  units: readonly BudgetUnit[],
  log: UnitLog,
): ReviewSnapshot {
  const omitted = trimmedUnits(units, log);
  const kinds = new Set(omitted.map((unit) => unit.kind));
  const flags = trimFlags(original, current, kinds);
  const prefix = prefixWithOmissions(original.prefix, current.prefix);
  const input = buildCompleteness({ ...material, trimmed: flags });
  const extra = extraNotes(original, current, kinds, omitted);
  const evidence = new Set(current.evidence);
  const completeness = {
    ...input,
    items: [...input.items, ...extra],
    status:
      input.status === 'complete' && extra.length > 0
        ? ('incomplete' as const)
        : input.status,
  };
  return {
    ...current,
    ...(prefix === undefined ? {} : { prefix, ...prefixCompatibility(prefix) }),
    ...(prefix === undefined
      ? {
          evidence: original.evidence.filter((item) => evidence.has(item)),
        }
      : {}),
    facts: flags.derivedFacts ? current.facts : original.facts,
    evidenceTruncated:
      original.evidenceTruncated || flags.evidence || kinds.has('reference'),
    contextTruncated:
      original.contextTruncated || flags.toolArguments || flags.checkpoints,
    historyTruncated: original.historyTruncated || flags.priorVerdicts,
    completeness,
    missing: missingLines(completeness),
    budget: {
      ...current.budget,
      truncatedSegments: segmentsOf(
        flags,
        current.customRules !== original.customRules,
        kinds.has('hint'),
        kinds.has('reference'),
      ),
      units: log,
    },
  };
}
