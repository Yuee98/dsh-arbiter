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

function chooseUnit(
  input: Allocation,
  current: ReviewSnapshot,
  log: UnitLog,
  unit: BudgetUnit,
  cap: number,
  baseline: ReturnType<typeof measureSnapshot>,
): {
  readonly unit: BudgetUnit;
  readonly tokens: number;
  readonly truncated: boolean;
} | null {
  const costs = new Map<string, number>();
  const costOf = (value: BudgetUnit): number => {
    const content = JSON.stringify(unitContent(value));
    const known = costs.get(content);
    if (known !== undefined) return known;
    const canonical = estimateTokenCount(content);
    // Canonical cost is already a lower bound; impossible copies need no render.
    const tokens =
      unit.capped && canonical > cap
        ? canonical
        : Math.max(
            canonical,
            contribution(
              current,
              addUnit(current, value),
              input.renderers,
              baseline,
            ),
          );
    costs.set(content, tokens);
    return tokens;
  };
  const fits = (value: BudgetUnit): boolean => {
    const tokens = costOf(value);
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
  if (fits(unit)) return { unit, tokens: costOf(unit), truncated: false };
  if (!unit.capped) return null;
  // All results yield before arguments; every channel still shares this call's C.
  const withArguments = fitScale((scale) => scaledUnit(unit, scale, 1), fits);
  const selected =
    withArguments ??
    fitScale((scale) => scaledUnit(unit, scale, 1, true), fits) ??
    fitScale((scale) => scaledUnit(unit, 0, scale), fits) ??
    fitScale((scale) => scaledUnit(unit, 0, scale, true), fits);
  return selected === null
    ? null
    : {
        unit: selected,
        tokens: costOf(selected),
        truncated: true,
      };
}

function fillOrdinary(
  input: Allocation,
  base: ReviewSnapshot,
): ReturnType<typeof measured> {
  let current = base;
  let log: UnitLog[number][] = [];
  let batchSize = 64;
  let state = measured(input, current, log);
  const baseline = measureSnapshot(base, input.renderers);
  let tokens = state.tokens;
  for (let index = 0; index < input.units.length; index += 1) {
    const batch = wholeBatch({
      base,
      current,
      units: input.units.slice(index, index + batchSize),
      log,
      target: input.target,
      tokens,
      renderers: input.renderers,
      baseline,
      finalize: (value, entries) => candidate(input, value, entries),
    });
    if (batch !== null) {
      current = batch.snapshot;
      log = [...batch.log];
      tokens = batch.tokens;
      state = { snapshot: batch.snapshot, ...batch.measurement };
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
        estimateTokenCount(
          JSON.stringify(unitContent(scaledUnit(unit, 0, 0, true))),
        ),
      ) > cap
    )
      continue;
    if (
      !unit.capped &&
      estimateTokenCount(JSON.stringify(unitContent(unit))) > remaining
    )
      continue;
    const selected = chooseUnit(input, state.snapshot, log, unit, cap, state);
    if (selected === null) continue;
    current = addUnit(current, selected.unit);
    log.push({
      id: unit.id,
      cap: unit.capped ? cap : null,
      tokens: selected.tokens,
      truncated: selected.truncated,
    });
    state = measured(input, current, log);
    tokens = state.tokens;
  }
  return state;
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
        ? {
            ...material,
            present: copy.length > 0,
            chars: copy.length,
            truncated: true,
          }
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
  for (const whole of [false, true]) {
    const fit = fitScale(
      (scale) => ({
        ...current,
        action: scaledAction(current.action, scale, whole),
      }),
      fits,
    );
    if (fit !== null) return candidate(input, fit, []);
  }
  let minimum = current;
  let minimumTokens = measured(input, minimum, []).tokens;
  for (const whole of [false, true]) {
    const value = {
      ...current,
      action: scaledAction(current.action, 0, whole),
    };
    const tokens = measured(input, value, []).tokens;
    if (tokens < minimumTokens) {
      minimum = value;
      minimumTokens = tokens;
    }
  }
  return candidate(input, minimum, []);
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
  const ordinary = overHard
    ? null
    : required.tokens > targetInputTokens
      ? required
      : fillOrdinary(input, required.snapshot);
  const selected = ordinary?.snapshot ?? hardDegrade(input, required.snapshot);
  const final =
    renderers === PRODUCTION_PACKAGE && ordinary !== null
      ? ordinary
      : measureSnapshot(selected, renderers);
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
  const request =
    renderers === PRODUCTION_PACKAGE
      ? final.chat
      : renderers.renderChat(snapshot);
  return { snapshot, system: request.system, user: request.user };
}
