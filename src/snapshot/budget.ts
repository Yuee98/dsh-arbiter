/** One deterministic T/H/C allocator, shared by production and eval adapters. */
import { estimateTokenCount } from 'tokenx';
import type { ReviewSnapshot } from '../types.js';
import type { CompletenessInput } from './completeness.js';
import { PRODUCTION_PACKAGE } from '../reviewer/package.js';
import {
  contribution,
  measureSnapshot,
  type BudgetRenderers,
} from './budget-measure.js';
import {
  addUnit,
  baseSnapshot,
  candidateUnits,
  scaledUnit,
  unitContent,
  type BudgetUnit,
} from './budget-units.js';
import { describeBudget, type UnitLog } from './budget-diagnostics.js';
import { scaledAction } from './budget-action.js';
import { shortenedText } from './budget-text.js';
import { wholeBatch } from './budget-batch.js';

interface Allocation {
  readonly original: ReviewSnapshot;
  readonly material: Omit<CompletenessInput, 'trimmed'>;
  readonly units: readonly BudgetUnit[];
  readonly renderers: BudgetRenderers;
  readonly target: number;
}

function candidate(
  input: Allocation,
  current: ReviewSnapshot,
  log: UnitLog,
): ReviewSnapshot {
  return describeBudget(
    input.original,
    current,
    input.material,
    input.units,
    log,
  );
}

function measured(input: Allocation, current: ReviewSnapshot, log: UnitLog) {
  const snapshot = candidate(input, current, log);
  return { snapshot, ...measureSnapshot(snapshot, input.renderers) };
}

/** Maximum fitting head/tail copy, including its real omission wrapper. */
function fitScale<T>(
  copy: (scale: number) => T,
  fits: (value: T) => boolean,
): T | null {
  const minimal = copy(0);
  if (!fits(minimal)) return null;
  let lower = 0;
  let upper = 1;
  let best = minimal;
  for (let step = 0; step < 18; step += 1) {
    const scale = (lower + upper) / 2;
    const value = copy(scale);
    if (fits(value)) {
      lower = scale;
      best = value;
    } else upper = scale;
  }
  return best;
}

function unitCost(
  input: Allocation,
  current: ReviewSnapshot,
  unit: BudgetUnit,
): number {
  // Canonical wrapping prevents aggregate notice changes cancelling unit cost.
  return Math.max(
    estimateTokenCount(JSON.stringify(unitContent(unit))),
    contribution(current, addUnit(current, unit), input.renderers),
  );
}

function chooseUnit(
  input: Allocation,
  current: ReviewSnapshot,
  log: UnitLog,
  unit: BudgetUnit,
  cap: number,
): {
  readonly unit: BudgetUnit;
  readonly tokens: number;
  readonly truncated: boolean;
} | null {
  const fits = (value: BudgetUnit): boolean => {
    const tokens = unitCost(input, current, value);
    if (unit.capped && tokens > cap) return false;
    const nextLog = [
      ...log,
      {
        id: unit.id,
        cap: unit.capped ? cap : null,
        tokens,
        truncated: value !== unit,
      },
    ];
    return (
      measured(input, addUnit(current, value), nextLog).tokens <= input.target
    );
  };
  if (fits(unit))
    return { unit, tokens: unitCost(input, current, unit), truncated: false };
  if (!unit.capped) return null;
  // All results yield before arguments; every channel still shares this call's C.
  const withArguments = fitScale((scale) => scaledUnit(unit, scale, 1), fits);
  const selected =
    withArguments ?? fitScale((scale) => scaledUnit(unit, 0, scale), fits);
  return selected === null
    ? null
    : {
        unit: selected,
        tokens: unitCost(input, current, selected),
        truncated: true,
      };
}

function fillOrdinary(input: Allocation, base: ReviewSnapshot): ReviewSnapshot {
  let current = base;
  let log: UnitLog[number][] = [];
  let batchSize = 64;
  let tokens = measured(input, current, log).tokens;
  for (let index = 0; index < input.units.length; index += 1) {
    const batch = wholeBatch({
      base,
      current,
      units: input.units.slice(index, index + batchSize),
      log,
      target: input.target,
      tokens,
      renderers: input.renderers,
      finalize: (value, entries) => candidate(input, value, entries),
    });
    if (batch !== null) {
      current = batch.snapshot;
      log = [...batch.log];
      tokens = batch.tokens;
      index += Math.min(batchSize, input.units.length - index) - 1;
      batchSize *= 2;
      continue;
    }
    batchSize = 64;
    const unit = input.units[index];
    if (unit === undefined) break;
    const remaining = input.target - tokens;
    if (remaining <= 0) break;
    const cap = Math.min(remaining, Math.floor(input.target / 10));
    if (unit.capped && cap === 0) continue;
    if (
      unit.capped &&
      Math.min(
        estimateTokenCount(JSON.stringify(unitContent(unit))),
        estimateTokenCount(JSON.stringify(unitContent(scaledUnit(unit, 0, 0)))),
      ) > cap
    )
      continue;
    if (
      !unit.capped &&
      estimateTokenCount(JSON.stringify(unitContent(unit))) > remaining
    )
      continue;
    const selected = chooseUnit(
      input,
      candidate(input, current, log),
      log,
      unit,
      cap,
    );
    if (selected === null) continue;
    current = addUnit(current, selected.unit);
    log.push({
      id: unit.id,
      cap: unit.capped ? cap : null,
      tokens: selected.tokens,
      truncated: selected.truncated,
    });
    tokens = measured(input, current, log).tokens;
  }
  return candidate(input, current, log);
}

function guidanceCopy(
  snapshot: ReviewSnapshot,
  id: 'project-rules' | 'custom-rules',
  scale: number,
): ReviewSnapshot {
  const text =
    id === 'project-rules' ? snapshot.projectRules : snapshot.customRules;
  if (text === null || text.length === 0) return snapshot;
  const copy =
    scale === 0 ? '' : shortenedText(text, Math.floor(text.length * scale));
  return {
    ...snapshot,
    ...(id === 'project-rules'
      ? { projectRules: copy.length === 0 ? null : copy }
      : { customRules: copy }),
    materials: snapshot.materials.map((material) =>
      material.id === id
        ? { ...material, chars: copy.length, truncated: true }
        : material,
    ),
  };
}

function hardDegrade(input: Allocation, base: ReviewSnapshot): ReviewSnapshot {
  let current = base;
  const fits = (value: ReviewSnapshot) =>
    measured(input, value, []).tokens <= base.budget.maxInputTokens;
  for (const id of ['custom-rules', 'project-rules'] as const) {
    const fit = fitScale((scale) => guidanceCopy(current, id, scale), fits);
    if (fit !== null) return candidate(input, fit, []);
    current = guidanceCopy(current, id, 0);
    if (fits(current)) return candidate(input, current, []);
  }
  const fit = fitScale(
    (scale) => ({ ...current, action: scaledAction(current.action, scale) }),
    fits,
  );
  if (fit !== null) return candidate(input, fit, []);
  const minimum = { ...current, action: scaledAction(current.action, 0) };
  return candidate(
    input,
    measured(input, minimum, []).tokens < measured(input, current, []).tokens
      ? minimum
      : current,
    [],
  );
}

export function truncateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  maxInputTokens: number,
  material: Omit<CompletenessInput, 'trimmed'>,
  targetInputTokens = Math.min(6_000, maxInputTokens),
  renderers: BudgetRenderers = PRODUCTION_PACKAGE,
) {
  const original: ReviewSnapshot = {
    ...base,
    budget: {
      targetInputTokens,
      maxInputTokens,
      estimatedInputTokens: 0,
      truncatedSegments: [],
    },
  };
  const input: Allocation = {
    original,
    material,
    units: candidateUnits(original),
    renderers,
    target: targetInputTokens,
  };
  const required = measured(input, baseSnapshot(original), []);
  const overHard = required.tokens > maxInputTokens;
  const selected = overHard
    ? hardDegrade(input, required.snapshot)
    : required.tokens > targetInputTokens
      ? required.snapshot
      : fillOrdinary(input, required.snapshot);
  const final = measureSnapshot(selected, renderers);
  const snapshot: ReviewSnapshot = {
    ...selected,
    budget: {
      ...selected.budget,
      baseInputTokens: required.tokens,
      estimatedInputTokens: final.tokens,
      ...(overHard
        ? { targetExceededReason: 'hard-degradation' as const }
        : required.tokens > targetInputTokens
          ? { targetExceededReason: 'base-input' as const }
          : {}),
      truncatedSegments: [
        ...selected.budget.truncatedSegments,
        ...(final.tokens > maxInputTokens ? ['OVER_BUDGET'] : []),
      ],
    },
  };
  const request = renderers.renderChat(snapshot);
  return { snapshot, system: request.system, user: request.user };
}
