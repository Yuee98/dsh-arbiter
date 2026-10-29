import { createHash } from 'node:crypto';
import type {
  ReviewScores,
  ReviewScoreTrail,
  ReviewStageRecord,
  TraceStage,
} from '../types.js';
export function json(value: unknown): string {
  return JSON.stringify(value ?? null);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function rowText(value: unknown, fallback = ''): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'bigint')
    return String(value);
  return fallback;
}

export function rowNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function rowJson(value: unknown): unknown {
  if (typeof value !== 'string') return null;
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed;
  } catch {
    return null;
  }
}

export function rowStrings(value: unknown): string[] {
  const parsed = rowJson(value);
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function rowTrace(value: unknown): TraceStage[] {
  const parsed = rowJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (entry): entry is TraceStage =>
      isRecord(entry) &&
      typeof entry['stage'] === 'string' &&
      typeof entry['result'] === 'string' &&
      typeof entry['at'] === 'number',
  );
}

export function rowDistribution(
  value: unknown,
): Readonly<Record<string, number>> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'number' || !Number.isFinite(entry)) return null;
    out[key] = entry;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * A stored score pair, or null when it cannot be interpreted.
 *
 * Every field a decision needs is required: the two bands, the required
 * authorization the matrix applied, the verdict and the contract version that
 * names the semantics. A row missing any of them is not guessed at — reporting a
 * default band would state a decision this build never made.
 *
 * A current record writes exactly this shape. A row whose stored object does not
 * match it reports no score at all, which is the honest answer: reporting a
 * default band would state a decision this build never made.
 */
export function rowScores(value: unknown): ReviewScores | null {
  const parsed = rowJson(value);
  if (!isRecord(parsed)) return null;
  const source = parsed['source'];
  if (source !== 'chat' && source !== 'decision') return null;
  const verdict = parsed['verdict'];
  if (
    verdict !== 'review-allow' &&
    verdict !== 'review-deny' &&
    verdict !== 'review-escalate'
  )
    return null;
  const risk = parsed['risk'];
  const authorization = parsed['authorization'];
  const required = parsed['requiredAuthorization'];
  const contractVersion = parsed['contractVersion'];
  if (
    typeof risk !== 'number' ||
    typeof authorization !== 'number' ||
    typeof required !== 'number' ||
    typeof contractVersion !== 'string'
  )
    return null;
  const audit = parsed['audit'];
  if (!isRecord(audit)) return null;
  const riskTrail = rowTrail(audit['risk']);
  const authorizationTrail = rowTrail(audit['authorization']);
  if (riskTrail === null || authorizationTrail === null) return null;
  return {
    contractVersion,
    source,
    risk,
    authorization,
    requiredAuthorization: required,
    verdict,
    audit: { risk: riskTrail, authorization: authorizationTrail },
  };
}

/** One field's stored score trail, or null when it cannot be interpreted. */
function rowTrail(value: unknown): ReviewScoreTrail | null {
  if (!isRecord(value)) return null;
  const score = value['score'];
  if (typeof score !== 'number') return null;
  const point = value['point'];
  return {
    native: rowDistribution(value['native']),
    published: rowDistribution(value['published']),
    point: typeof point === 'number' ? point : null,
    score,
  };
}

/**
 * A stored review stage, or null when it is absent or not one of the four.
 *
 * The four values are a closed set: an unrecognized string is reported as absent
 * rather than passed through, so a reader that switches on the stage cannot be
 * handed a value it has no branch for.
 */
export function rowReviewStage(value: unknown): ReviewStageRecord | null {
  if (typeof value !== 'string') return null;
  switch (value) {
    case 'review-allow':
    case 'review-deny':
    case 'review-escalate':
    case 'error-escalate':
      return value;
    default:
      return null;
  }
}

export function rowChanges(value: unknown): number {
  return isRecord(value) ? rowNumber(value['changes']) : 0;
}

export function asRow(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

export function asRows(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
