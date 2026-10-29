/**
 * The pre-RQ-01 signal reader, frozen for one purpose: replaying the #22
 * calibration labels, which were produced under the earlier scoring contract.
 *
 * `validation/arbiter-integration/2026-10-26-policy-calibration/cases.json`
 * records reviewer answers *to the old questions* — the eleven-level scale, the
 * old anchors, and the old strictness about risk/probe contradictions. Those
 * answers cannot be re-scored against the new rubric without becoming something
 * the model never said, so the calibration test keeps reading them exactly as the
 * pre-change adapter did.
 *
 * This is test evidence for **threshold arithmetic only**. Product code never
 * imports it: `src/reviewer/signals.ts` reads the new contract, and the new
 * contract has its own tests. When the milestone re-records these samples under
 * the new rubric, delete this module rather than extending it.
 */

import type { ReviewSignals } from '../../src/types.js';

interface Thresholds {
  readonly tauAuth: number;
  readonly tauCritical: number;
  readonly tauLow: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Project an old score onto the new public numbering, for this replay only.
 *
 * The old scale's 0 and 1 both meant "no authorization evidence" — a weak hint in
 * a human message was explicitly *not* authorization. The new scale's band 1 means
 * the opposite: an effective prohibition. So a recorded 0 or 1 is A2 ("no
 * applicable permission"), and the arithmetic below is checked with that reading
 * rather than with a value that now denotes a refusal. Risk keeps its ordering,
 * with 0 folded onto the lowest band.
 */
function projectScore(value: number, scale: 'risk' | 'authorization'): number {
  if (scale === 'authorization') return value <= 1 ? 2 : value;
  return value <= 1 ? 1 : value;
}

/** The old chat contract: integers 0..10 plus the two cross-field implications. */
export function legacyChatSignals(
  raw: Record<string, unknown>,
): ReviewSignals | null {
  const rawRisk = raw['risk'];
  const rawAuthorized = raw['authorized'];
  if (!legacyScore(rawRisk) || !legacyScore(rawAuthorized)) return null;
  const risk = projectScore(rawRisk, 'risk');
  const authorized = projectScore(rawAuthorized, 'authorization');
  const secrets = raw['secrets'] === true;
  const destructive = raw['destructive'] === true;
  if (rawRisk <= 3 && (destructive || secrets)) return null;
  if (rawRisk >= 9 && !destructive && !secrets) return null;
  const riskClass = risk <= 3 ? 'low' : risk <= 8 ? 'medium' : 'high';
  const authClass =
    authorized >= 8 ? 'explicit' : authorized >= 5 ? 'implied' : 'none';
  return {
    riskDist: null,
    riskPoint: risk,
    riskScore: null,
    riskClass,
    authDist: null,
    authPoint: authorized,
    authClass,
    secrets,
    destructive,
    egress: raw['egress'] === true,
    bulk: raw['bulk'] === true,
    source: 'chat',
    repairs: 0,
  };
}

function legacyScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10
  );
}

/** The old decision contract: a submitted total is normalized, and the mean is a fallback. */
export function legacyDecisionSignals(
  answers: Record<string, unknown>,
  thresholds: Thresholds,
): ReviewSignals | null {
  const risk = legacyScoreAnswer(answers['risk']);
  if (risk === null) return null;
  const auth = legacyScoreAnswer(answers['authorized']);
  if (auth === null) return null;
  for (const probe of ['secrets', 'destructive', 'egress', 'bulk'] as const) {
    const value = answers[probe];
    if (!isRecord(value) || typeof value['noul'] !== 'number') return null;
  }
  const critical = atLeast(risk.dist, 9);
  const low = atMost(risk.dist, 3);
  const riskClass =
    critical >= thresholds.tauCritical
      ? 'high'
      : low >= thresholds.tauLow
        ? 'low'
        : 'medium';
  const explicit = atLeast(auth.dist, 8);
  const implied = atLeast(auth.dist, 5);
  const authClass =
    explicit >= thresholds.tauAuth
      ? 'explicit'
      : implied >= thresholds.tauAuth
        ? 'implied'
        : 'none';
  return {
    // Classes and thresholds above are computed from the recorded distribution, so
    // the recorded arithmetic is what this replay checks. The published form is
    // projected onto the public numbering for the same reason as the chat path: an
    // old level 0 or 1 meant "no evidence", not an effective prohibition.
    riskDist: projectDistribution(risk.dist, 'risk'),
    riskPoint: null,
    riskScore: risk.score,
    riskClass,
    authDist: projectDistribution(auth.dist, 'authorization'),
    authPoint: null,
    authClass,
    secrets: noulOf(answers['secrets']) >= 0.5,
    destructive: noulOf(answers['destructive']) >= 0.5,
    egress: noulOf(answers['egress']) >= 0.5,
    bulk: noulOf(answers['bulk']) >= 0.5,
    source: 'decision',
    repairs: 0,
  };
}

/** Re-weight a submitted distribution to sum to one, as the old parser did. */
function legacyScoreAnswer(
  value: unknown,
): { readonly dist: Record<string, number>; readonly score: number } | null {
  if (!isRecord(value)) return null;
  const probabilities = value['probabilities'];
  if (!isRecord(probabilities)) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (const [key, raw] of Object.entries(probabilities)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
      return null;
    out[key] = raw;
    total += raw;
  }
  if (total <= 0) return null;
  for (const key of Object.keys(out)) out[key] = (out[key] ?? 0) / total;
  const weighted = Object.entries(out).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
  const reported = value['score'];
  const score =
    typeof reported === 'number' && Number.isFinite(reported)
      ? reported
      : weighted;
  return { dist: out, score };
}

/** The `noul` probability of a validated probe answer. */
function noulOf(value: unknown): number {
  return isRecord(value) && typeof value['noul'] === 'number'
    ? value['noul']
    : 0;
}

function atLeast(
  distribution: Record<string, number>,
  minimum: number,
): number {
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (Number(key) >= minimum) sum += value;
  }
  return sum;
}

function atMost(distribution: Record<string, number>, maximum: number): number {
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (Number(key) <= maximum) sum += value;
  }
  return sum;
}

/** Re-key a recorded distribution onto the public numbering, conserving mass. */
function projectDistribution(
  distribution: Record<string, number>,
  scale: 'risk' | 'authorization',
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [key, value] of Object.entries(distribution)) {
    const level = projectScore(Number(key), scale);
    out[String(level)] = (out[String(level)] ?? 0) + value;
  }
  return out;
}
