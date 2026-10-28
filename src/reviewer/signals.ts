import type { PolicyThresholds, ReviewSignals } from '../types.js';

export interface RawChatSignals {
  readonly risk: number;
  readonly authorized: number;
  readonly secrets: boolean;
  readonly destructive: boolean;
  readonly egress: boolean;
  readonly bulk: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function extractJsonObject(text: string): string {
  const trimmed = text.trim();
  const fenced = /```(?:json)?\s*([\s\S]*?)```/u.exec(trimmed);
  const candidate = fenced?.[1]?.trim() ?? trimmed;
  const start = candidate.indexOf('{');
  const end = candidate.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return candidate;
  return candidate.slice(start, end + 1);
}

/**
 * The shared risk-category boundary: `low` is 0–3 for both backends
 * (`docs/reviewer.md#design-5-5`). It is a semantic definition, not a tuning
 * knob — a configurable version of it would let an advanced setting redefine
 * what a risk level means and desynchronize the two protocols' authorization
 * classes.
 */
const LOW_RISK_MAX = 3;

function isScore(value: unknown): value is number {
  return (
    typeof value === 'number' &&
    Number.isInteger(value) &&
    value >= 0 &&
    value <= 10
  );
}

export function validateChatObject(value: unknown): {
  readonly ok: boolean;
  readonly raw?: RawChatSignals;
  readonly error?: string;
} {
  if (!isRecord(value))
    return { ok: false, error: 'reviewer output must be one JSON object' };
  const keys = Object.keys(value).sort();
  const expected = [
    'authorized',
    'bulk',
    'destructive',
    'egress',
    'risk',
    'secrets',
  ];
  if (
    keys.length !== expected.length ||
    keys.some((key, index) => key !== expected[index])
  ) {
    return {
      ok: false,
      error: `reviewer output must contain exactly ${expected.join(', ')}; received ${keys.join(', ')}`,
    };
  }
  const risk = value['risk'];
  const authorized = value['authorized'];
  if (!isScore(risk)) {
    return { ok: false, error: 'risk must be an integer from 0 through 10' };
  }
  if (!isScore(authorized)) {
    return {
      ok: false,
      error: 'authorized must be an integer from 0 through 10',
    };
  }
  for (const probe of ['secrets', 'destructive', 'egress', 'bulk'] as const) {
    if (typeof value[probe] !== 'boolean') {
      return { ok: false, error: `${probe} must be a boolean` };
    }
  }
  const raw: RawChatSignals = {
    risk,
    authorized,
    secrets: value['secrets'] === true,
    destructive: value['destructive'] === true,
    egress: value['egress'] === true,
    bulk: value['bulk'] === true,
  };
  if (raw.risk <= 3 && (raw.destructive || raw.secrets)) {
    return {
      ok: false,
      error:
        'contradiction: risk <= 3 requires destructive and secrets to be false',
    };
  }
  if (raw.risk >= 9 && !raw.destructive && !raw.secrets) {
    return {
      ok: false,
      error:
        'contradiction: risk >= 9 requires destructive or secrets to be true',
    };
  }
  return { ok: true, raw };
}

export function parseChatText(
  text: string,
): ReturnType<typeof validateChatObject> {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObject(text));
  } catch (error) {
    return {
      ok: false,
      error: `reviewer output is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return validateChatObject(value);
}

export function signalsFromChat(
  raw: RawChatSignals,
  repairs: number,
): ReviewSignals {
  const riskClass = raw.risk <= 3 ? 'low' : raw.risk <= 8 ? 'medium' : 'high';
  const authClass =
    raw.authorized >= 8 ? 'explicit' : raw.authorized >= 5 ? 'implied' : 'none';
  return {
    riskDist: null,
    riskPoint: raw.risk,
    riskScore: null,
    riskClass,
    authDist: null,
    authPoint: raw.authorized,
    authClass,
    secrets: raw.secrets,
    destructive: raw.destructive,
    egress: raw.egress,
    bulk: raw.bulk,
    source: 'chat',
    repairs,
  };
}

function normalizeDistribution(value: unknown): Record<string, number> | null {
  if (!isRecord(value)) return null;
  const out: Record<string, number> = {};
  let total = 0;
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0)
      return null;
    const level = Number(key);
    if (!Number.isInteger(level) || level < 0 || level > 10) return null;
    out[String(level)] = raw;
    total += raw;
  }
  if (total <= 0) return null;
  for (const key of Object.keys(out)) {
    out[key] = (out[key] ?? 0) / total;
  }
  return out;
}

function probabilityAtLeast(
  distribution: Readonly<Record<string, number>>,
  minimum: number,
): number {
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (Number(key) >= minimum) sum += value;
  }
  return sum;
}

function probabilityAtMost(
  distribution: Readonly<Record<string, number>>,
  maximum: number,
): number {
  let sum = 0;
  for (const [key, value] of Object.entries(distribution)) {
    if (Number(key) <= maximum) sum += value;
  }
  return sum;
}

function scoreAnswer(
  answers: Record<string, unknown>,
  name: string,
): { dist: Record<string, number>; score: number } | string {
  const value = answers[name];
  if (!isRecord(value)) return `missing ${name} answer`;
  const dist = normalizeDistribution(value['probabilities']);
  if (dist === null)
    return `${name} answer has no valid probability distribution`;
  const score = value['score'];
  const weighted = Object.entries(dist).reduce(
    (sum, [level, probability]) => sum + Number(level) * probability,
    0,
  );
  if (
    typeof score === 'number' &&
    Number.isFinite(score) &&
    score >= 0 &&
    score <= 10
  ) {
    return { dist, score };
  }
  return { dist, score: weighted };
}
function noul(
  answers: Record<string, unknown>,
  name: string,
): boolean | string {
  const value = answers[name];
  if (!isRecord(value)) return `missing ${name} answer`;
  const raw = value['noul'];
  if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
    return `${name} answer has no valid noul probability`;
  }
  return raw >= 0.5;
}

/**
 * Where a decision response keeps its answers.
 *
 * Two placements exist among the supported endpoints, and they are not
 * alternatives for the same vendor — they belong to different envelopes:
 *
 *   Cloudflare edge   { result: { model, answers, usage }, success, errors, messages }
 *   native endpoints  { model, answers, usage }
 *
 * The object is taken whole rather than unpacked here so the caller can also
 * read the sibling `usage` from the same payload. An earlier version looked for
 * `result.response`, a key no documented endpoint produces; it existed only in
 * this file's test fixture, which is how the mismatch stayed invisible.
 */
export function decisionAnswers(
  body: Record<string, unknown>,
): Record<string, unknown> | undefined {
  const candidates = [
    isRecord(body['result']) && isRecord(body['result']['answers'])
      ? body['result']['answers']
      : undefined,
    isRecord(body['answers']) ? body['answers'] : undefined,
  ];
  return candidates.find((candidate) => candidate !== undefined);
}

export function parseDecisionResponse(
  body: unknown,
  thresholds: PolicyThresholds,
):
  | { readonly ok: true; readonly signals: ReviewSignals }
  | { readonly ok: false; readonly error: string } {
  if (!isRecord(body))
    return { ok: false, error: 'decision response is not a JSON object' };
  const answers = decisionAnswers(body);
  if (answers === undefined)
    return { ok: false, error: 'decision response has no risk answer' };

  const risk = scoreAnswer(answers, 'risk');
  if (typeof risk === 'string') return { ok: false, error: risk };
  const auth = scoreAnswer(answers, 'authorized');
  if (typeof auth === 'string') return { ok: false, error: auth };
  const secrets = noul(answers, 'secrets');
  if (typeof secrets === 'string') return { ok: false, error: secrets };
  const destructive = noul(answers, 'destructive');
  if (typeof destructive === 'string') return { ok: false, error: destructive };
  const egress = noul(answers, 'egress');
  if (typeof egress === 'string') return { ok: false, error: egress };
  const bulk = noul(answers, 'bulk');
  if (typeof bulk === 'string') return { ok: false, error: bulk };

  const critical = probabilityAtLeast(risk.dist, 9);
  const low = probabilityAtMost(risk.dist, LOW_RISK_MAX);
  const riskClass =
    critical >= thresholds.tauCritical
      ? 'high'
      : low >= thresholds.tauLow
        ? 'low'
        : 'medium';
  const explicit = probabilityAtLeast(auth.dist, 8);
  const implied = probabilityAtLeast(auth.dist, 5);
  const authClass =
    explicit >= thresholds.tauAuth
      ? 'explicit'
      : implied >= thresholds.tauAuth
        ? 'implied'
        : 'none';

  return {
    ok: true,
    signals: {
      riskDist: risk.dist,
      riskPoint: null,
      riskScore: risk.score,
      riskClass,
      authDist: auth.dist,
      authPoint: null,
      authClass,
      secrets,
      destructive,
      egress,
      bulk,
      source: 'decision',
      repairs: 0,
    },
  };
}
