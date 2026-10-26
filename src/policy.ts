/**
 * The review decision engine.
 *
 * Models produce signals; this module produces the decision. The regular
 * strategy is shared by `normal` and `strict` (the only difference between
 * those modes is whether the plugin opens a human approval). `progress` uses
 * the same rule order with a wider set of conditions. Every branch names the
 * R-rule it applied so the audit can be replayed.
 */

import type {
  DerivedFacts,
  PolicyDecision,
  PolicyThresholds,
  ReviewSignals,
  ReviewVerdict,
  ProbeMode,
} from './types.js';

export type StrategyName = 'normal' | 'progress';

/**
 * The shared risk-category boundary (`docs/reviewer.md#design-5-5`).
 *
 * `low` is 0–3 for both backends, and this cut also defines the low-risk fast
 * path's "no authorization required" band. It is deliberately a constant rather
 * than a policy field: making it configurable would redefine what a risk level
 * *means*, and a wider value could turn a medium-risk decision call into an
 * unauthorized allow while the equivalent chat call still escalated. A tuning
 * parameter must not be able to move an authorization category.
 */
const LOW_RISK_MAX = 3;

/**
 * The review strategy a session's mode selects.
 *
 * `normal` and `strict` deliberately share one strategy: the only difference
 * between those modes is whether the plugin opens a human approval, which is a
 * settlement decision, not a review one. Keeping the mapping here is what makes
 * that identity checkable instead of an inline ternary repeated per call site.
 */
export function strategyFor(mode: string): StrategyName {
  return mode === 'progress' ? 'progress' : 'normal';
}

function probabilityAtLeast(
  distribution: Readonly<Record<string, number>> | null,
  minimum: number,
): number | null {
  if (distribution === null) return null;
  let total = 0;
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total += value;
    const level = Number(key);
    if (Number.isFinite(level) && level >= minimum) sum += value;
  }
  return total > 0 ? sum / total : null;
}

function probabilityAtMost(
  distribution: Readonly<Record<string, number>> | null,
  maximum: number,
): number | null {
  if (distribution === null) return null;
  let total = 0;
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (typeof value !== 'number' || !Number.isFinite(value)) continue;
    total += value;
    const level = Number(key);
    if (Number.isFinite(level) && level <= maximum) sum += value;
  }
  return total > 0 ? sum / total : null;
}

function certainty(value: number | null): boolean {
  return value !== null;
}

function riskGate(
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): {
  readonly passed: boolean;
  readonly rule: string;
  readonly observed: string;
} {
  if (signals.riskPoint !== null) {
    const point = signals.riskPoint;
    if (point <= thresholds.chatMediumRiskMax) {
      return {
        passed: true,
        rule: 'R7',
        observed: `riskPoint=${String(point)}`,
      };
    }
    return {
      passed: false,
      rule: 'R5',
      observed: `riskPoint=${String(point)} > ${String(thresholds.chatMediumRiskMax)}`,
    };
  }
  const low = probabilityAtMost(signals.riskDist, LOW_RISK_MAX);
  const medium = probabilityAtMost(
    signals.riskDist,
    thresholds.mediumRiskCeiling,
  );
  if (signals.riskClass === 'low' && low !== null && low >= thresholds.tauLow) {
    return {
      passed: true,
      rule: 'R7',
      observed: `P(risk<=3)=${low.toFixed(2)}`,
    };
  }
  if (medium !== null && medium >= thresholds.tauRisk) {
    return {
      passed: true,
      rule: 'R7',
      observed: `P(risk<=${String(thresholds.mediumRiskCeiling)})=${medium.toFixed(2)}`,
    };
  }
  // A distribution that fails this gate has not produced an identified risk: it
  // produced a reading whose mass is spread across the scale. Reporting that as
  // R5 would tell the human a risk was measured when the honest answer is that
  // the signal was not decisive, so it is reported as R8.
  //
  // Note the consequence for the decision protocol, recorded as a limitation in
  // the calibration report rather than hidden: `riskClass === 'high'` is exactly
  // `P(risk>=9) >= tauCritical`, which R2 already denies, so a decision call can
  // never reach this gate with an identified risk and R5 is unreachable for that
  // protocol. R5 needs the operation-class facts the matrix names (production
  // change, security-control change, irreversible delete), which the signal model
  // does not yet carry; adding them changes the reviewer contract and is out of
  // scope for a threshold-calibration issue.
  return {
    passed: false,
    rule: 'R8',
    observed: `P(risk<=${String(thresholds.mediumRiskCeiling)})=${(medium ?? 0).toFixed(2)}`,
  };
}

function authGate(
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
  required: 'none' | 'implied' | 'explicit',
): { readonly passed: boolean; readonly observed: string } {
  if (required === 'none')
    return { passed: true, observed: 'authorization not required' };
  if (signals.authPoint !== null) {
    const minimum = required === 'explicit' ? 8 : 5;
    return {
      passed: signals.authPoint >= minimum,
      observed: `authPoint=${String(signals.authPoint)} (needs >=${String(minimum)})`,
    };
  }
  const threshold = required === 'explicit' ? 8 : 5;
  const probability = probabilityAtLeast(signals.authDist, threshold);
  return {
    passed: probability !== null && probability >= thresholds.tauAuth,
    observed: `P(auth>=${String(threshold)})=${(probability ?? 0).toFixed(2)}`,
  };
}

function allow(
  rule: string,
  reason: string,
  strategy: StrategyName,
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): PolicyDecision {
  return {
    verdict: 'review-allow',
    decisionRules: [rule],
    reason,
    strategy,
    details: {
      riskClass: signals.riskClass,
      authClass: signals.authClass,
      thresholds,
    },
  };
}

function escalate(
  rule: string,
  reason: string,
  strategy: StrategyName,
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): PolicyDecision {
  return {
    verdict: 'review-escalate',
    decisionRules: [rule],
    reason,
    strategy,
    details: {
      riskClass: signals.riskClass,
      authClass: signals.authClass,
      thresholds,
    },
  };
}

function deny(
  rule: string,
  reason: string,
  strategy: StrategyName,
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): PolicyDecision {
  return {
    verdict: 'review-deny',
    decisionRules: [rule],
    reason,
    strategy,
    details: {
      riskClass: signals.riskClass,
      authClass: signals.authClass,
      thresholds,
    },
  };
}

interface DecisionContext {
  readonly signals: ReviewSignals;
  readonly strategy: StrategyName;
  readonly thresholds: PolicyThresholds;
}

function isCriticalRisk({ signals, thresholds }: DecisionContext): boolean {
  const probability = probabilityAtLeast(signals.riskDist, 9);
  return (
    signals.riskClass === 'high' ||
    (signals.riskPoint !== null && signals.riskPoint >= 9) ||
    (signals.riskDist !== null &&
      certainty(probability) &&
      (probability ?? 0) >= thresholds.tauCritical)
  );
}

function fixedDecision(context: DecisionContext): PolicyDecision | null {
  const { signals, strategy, thresholds } = context;
  if (signals.secrets && signals.egress) {
    return deny(
      'R1',
      'sensitive material leaves the machine across a trust boundary',
      strategy,
      signals,
      thresholds,
    );
  }
  if (isCriticalRisk(context)) {
    return deny(
      'R2',
      'critical risk of irreversible damage',
      strategy,
      signals,
      thresholds,
    );
  }
  if (signals.destructive && signals.bulk) {
    return escalate(
      'R4',
      'bulk irreversible destruction requires a human decision',
      strategy,
      signals,
      thresholds,
    );
  }
  return null;
}

/**
 * The authorization level a call needs before the plugin may delegate it.
 *
 * Both protocols have to reach the same answer for the same facts, so the two
 * branches below are two spellings of one rule rather than two policies: the
 * chat point comparison and the decision class comparison must not drift apart.
 * The rule itself is unchanged by #22 — the calibration only measures the
 * probability gates and the risk ceilings against a labelled sample set, and the
 * `implied` authorization band that this rule leaves unused above the low-risk
 * boundary is recorded as a limitation rather than silently redefined here.
 */
function requiredAuthorization(
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): 'none' | 'explicit' {
  if (signals.riskPoint !== null) {
    return signals.riskPoint >= thresholds.explicitFromRisk
      ? 'explicit'
      : 'none';
  }
  return signals.riskClass === 'low' ? 'none' : 'explicit';
}

function bulkEgressDecision(context: DecisionContext): PolicyDecision {
  const { signals, strategy, thresholds } = context;
  if (!thresholds.allowBulkEgress) {
    return escalate(
      'R6',
      'bulk external sending requires a human decision in this mode',
      strategy,
      signals,
      thresholds,
    );
  }
  const explicit = authGate(signals, thresholds, 'explicit');
  if (!explicit.passed) {
    return escalate(
      'R6',
      `bulk external sending requires explicit authorization (${explicit.observed})`,
      strategy,
      signals,
      thresholds,
    );
  }
  const gate = riskGate(signals, thresholds);
  if (!gate.passed) {
    return escalate(
      'R6',
      `bulk external sending exceeds the risk ceiling (${gate.observed})`,
      strategy,
      signals,
      thresholds,
    );
  }
  return allow(
    'R6',
    'bulk external sending with explicit authorization',
    strategy,
    signals,
    thresholds,
  );
}

function riskDecision(context: DecisionContext): PolicyDecision {
  const { signals, strategy, thresholds } = context;
  if (signals.riskClass === 'low' && !signals.destructive && !signals.secrets) {
    return allow(
      'R7',
      'ordinary low-risk action',
      strategy,
      signals,
      thresholds,
    );
  }
  const gate = riskGate(signals, thresholds);
  if (!gate.passed) {
    // The gate distinguishes two different findings. A failure because the
    // observed risk sits above the ceiling is an identified risk (R5); a failure
    // because the signal itself does not clear the probability gate is an
    // unresolved uncertainty (R8). Reporting both as R5 would tell the human that
    // a risk was measured when the honest answer is that the model was not
    // confident enough to measure one — so the gate's own rule is carried out.
    return escalate(
      gate.rule,
      gate.rule === 'R8'
        ? `the available signals did not clear the risk gate (${gate.observed})`
        : `risk exceeds the selected ceiling (${gate.observed})`,
      strategy,
      signals,
      thresholds,
    );
  }
  // Non-bulk destruction still needs explicit authorization and the regular
  // risk ceiling; deleting one item is not automatically human-only.
  if (
    signals.destructive &&
    signals.riskPoint !== null &&
    signals.riskPoint > thresholds.chatMediumRiskMax
  ) {
    return escalate(
      'R5',
      'destructive action exceeds the selected risk ceiling',
      strategy,
      signals,
      thresholds,
    );
  }
  return allow(
    'R7',
    'explicitly authorized action within the selected risk ceiling',
    strategy,
    signals,
    thresholds,
  );
}

/**
 * Apply fixed denials (R1, R2), mandatory escalation (R4, R3), mode-dependent
 * bulk egress (R6), and finally the regular risk ceiling (R5, R7).
 */
export function decideReview(
  signals: ReviewSignals,
  strategy: StrategyName,
  thresholds: PolicyThresholds,
): PolicyDecision {
  const context = { signals, strategy, thresholds };
  const fixed = fixedDecision(context);
  if (fixed !== null) return fixed;
  const auth = authGate(
    signals,
    thresholds,
    requiredAuthorization(signals, thresholds),
  );
  if (!auth.passed) {
    return escalate(
      'R3',
      `authorization is insufficient (${auth.observed})`,
      strategy,
      signals,
      thresholds,
    );
  }
  if (
    signals.bulk &&
    signals.egress &&
    !signals.secrets &&
    !signals.destructive
  ) {
    return bulkEgressDecision(context);
  }
  return riskDecision(context);
}

/**
 * Apply `probeMode: override`: a complete fact may make a probe more dangerous,
 * never safer. Facts never turn an observed risk off.
 */
export function applyProbeOverrides(
  signals: ReviewSignals,
  facts: DerivedFacts | null,
  mode: ProbeMode,
): ReviewSignals {
  if (mode !== 'override' || facts === null) return signals;
  return {
    ...signals,
    secrets: signals.secrets || facts.observed.credentialPaths.length > 0,
    destructive:
      signals.destructive ||
      facts.observed.pipelineExec.length > 0 ||
      facts.expansionRisk !== null,
    egress: signals.egress || facts.observed.networkCommands.length > 0,
    bulk:
      signals.bulk ||
      facts.observed.writes.length >= 10 ||
      (signals.destructive && facts.observed.writes.length > 1),
  };
}

/** Re-derive decision-backend classes under the currently effective thresholds. */
export function reclassifySignals(
  signals: ReviewSignals,
  thresholds: PolicyThresholds,
): ReviewSignals {
  if (signals.source !== 'decision') return signals;
  const atLeast = (
    distribution: Readonly<Record<string, number>> | null,
    minimum: number,
  ): number | null => {
    if (distribution === null) return null;
    let total = 0;
    let sum = 0;
    for (const [key, value] of Object.entries(distribution)) {
      total += value;
      if (Number(key) >= minimum) sum += value;
    }
    return total > 0 ? sum / total : null;
  };
  const atMost = (
    distribution: Readonly<Record<string, number>> | null,
    maximum: number,
  ): number | null => {
    if (distribution === null) return null;
    let total = 0;
    let sum = 0;
    for (const [key, value] of Object.entries(distribution)) {
      total += value;
      if (Number(key) <= maximum) sum += value;
    }
    return total > 0 ? sum / total : null;
  };
  const critical = atLeast(signals.riskDist, 9);
  const low = atMost(signals.riskDist, LOW_RISK_MAX);
  const riskClass =
    critical !== null && critical >= thresholds.tauCritical
      ? 'high'
      : low !== null && low >= thresholds.tauLow
        ? 'low'
        : 'medium';
  const explicit = atLeast(signals.authDist, 8);
  const implied = atLeast(signals.authDist, 5);
  const authClass =
    explicit !== null && explicit >= thresholds.tauAuth
      ? 'explicit'
      : implied !== null && implied >= thresholds.tauAuth
        ? 'implied'
        : 'none';
  return { ...signals, riskClass, authClass };
}

/** Re-evaluate a stored signal set under a comparison strategy without a model call. */
export function compareStrategies(
  signals: ReviewSignals,
  normal: PolicyThresholds,
  progress: PolicyThresholds,
): {
  readonly normal: ReviewVerdict;
  readonly progress: ReviewVerdict;
  readonly promoted: boolean;
} {
  const normalDecision = decideReview(signals, 'normal', normal);
  const progressDecision = decideReview(signals, 'progress', progress);
  return {
    normal: normalDecision.verdict,
    progress: progressDecision.verdict,
    promoted:
      normalDecision.verdict === 'review-escalate' &&
      progressDecision.verdict === 'review-allow',
  };
}
