/** Fast admission of unchanged whole units; ordinary fallback handles every cut. */
import { estimateTokenCount } from 'tokenx';
import type { ReviewSnapshot } from '../types.js';
import { measureSnapshot, type BudgetRenderers } from './budget-measure.js';
import { addUnits, unitContent, type BudgetUnit } from './budget-units.js';
import type { UnitLog } from './budget-diagnostics.js';

export function wholeBatch(options: {
  readonly base: ReviewSnapshot;
  readonly current: ReviewSnapshot;
  readonly units: readonly BudgetUnit[];
  readonly log: UnitLog;
  readonly target: number;
  readonly tokens: number;
  readonly renderers: BudgetRenderers;
  readonly finalize: (snapshot: ReviewSnapshot, log: UnitLog) => ReviewSnapshot;
}): {
  readonly snapshot: ReviewSnapshot;
  readonly log: UnitLog;
  readonly tokens: number;
} | null {
  if (options.units.length < 2) return null;
  let remaining = options.target - options.tokens;
  let baseline: ReturnType<typeof measureSnapshot> | undefined;
  const additions: UnitLog[number][] = [];
  for (const unit of options.units) {
    const canonical = estimateTokenCount(JSON.stringify(unitContent(unit)));
    const cap = Math.min(remaining, Math.floor(options.target / 10));
    if ((unit.capped && canonical > cap) || canonical > remaining) return null;
    // Unit envelopes are measured against the same fixed framework. Two tokens
    // cover list separators/rounding; aggregate omission notices cannot offset C.
    baseline ??= measureSnapshot(options.base, options.renderers);
    const full = measureSnapshot(
      addUnits(options.base, [unit]),
      options.renderers,
    );
    const tokens =
      Math.max(
        canonical,
        full.chat.estimatedInputTokens - baseline.chat.estimatedInputTokens,
        full.decision.estimatedInputTokens -
          baseline.decision.estimatedInputTokens,
      ) + 2;
    if ((unit.capped && tokens > cap) || tokens > remaining) return null;
    additions.push({
      id: unit.id,
      cap: unit.capped ? cap : null,
      tokens,
      truncated: false,
    });
    remaining -= tokens;
  }
  const log = [...options.log, ...additions];
  const snapshot = options.finalize(
    addUnits(options.current, options.units),
    log,
  );
  const tokens = measureSnapshot(snapshot, options.renderers).tokens;
  return tokens > options.target ? null : { snapshot, log, tokens };
}
