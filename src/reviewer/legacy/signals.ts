import {
  bandFromPublic,
  chatScore,
  distributionToPublic,
  validateNativeDistribution,
  weightedBand,
} from '../../review-contract/normalize.js';
import type { PolicyThresholds, ReviewSignals } from '../../types.js';

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
 * The shared risk-category boundary: `low` is 1–3 for both backends
 * (`docs/reviewer.md#design-5-5`). It is a semantic definition, not a tuning
 * knob — a configurable version of it would let an advanced setting redefine
 * what a risk level means and desynchronize the two protocols' authorization
 * classes.
 */
const LOW_RISK_MAX = 3;

/** A chat answer's public scale runs 1..10; see `docs/milestones`. */
function isScore(value: unknown): value is number {
  return chatScore(value).ok;
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
    return { ok: false, error: 'risk must be an integer from 1 through 10' };
  }
  if (!isScore(authorized)) {
    return {
      ok: false,
      error: 'authorized must be an integer from 1 through 10',
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
  // Risk and the probes are independent facts under the shared rubric: a
  // high-consequence action need not destroy data or read credentials, and a
  // negligible one may still lose disposable data. Cross-field implication was an
  // earlier contract's rule and would now reject legal classifications, so each
  // probe is validated for its own type only.
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

/**
 * One decision score field, read strictly and mapped by N0.
 *
 * The protocol answers with a distribution over its ten native levels (0..9). The
 * contract validates that distribution and derives the public band, so this adapter
 * holds no second copy of the rule. Nothing is repaired: a distribution that does
 * not sum to one, names level 10, or holds a bad probability is a failed read, and
 * an unreadable answer never becomes a score.
 */
function scoreAnswer(
  answers: Record<string, unknown>,
  name: 'risk' | 'authorized',
): { dist: Record<string, number>; score: number } | string {
  const value = answers[name];
  if (!isRecord(value)) return `missing ${name} answer`;
  const native = validateNativeDistribution(value['probabilities']);
  if (!native.ok) {
    // The reason class is safe to report: it names the violated rule, never the
    // reviewer's values.
    return `${name} answer has no valid probability distribution (${native.reason}: ${native.detail})`;
  }
  // The audit keeps the distribution on the public scale, because the engine reads
  // public bands; the native form stays available in the attempt's own record.
  const dist = distributionToPublic(native.value);
  return {
    dist,
    score: weightedBand(native.value),
  };
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
  _thresholds: PolicyThresholds,
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

  // The classes are derived from the public band the distribution reaches, not
  // from a probability tail: a legacy tail test can label an effective prohibition
  // as an ordinary `none`, and the two mean different things now. Every 0..10 tail
  // the older rules read is still available in `risk.dist`/`auth.dist`.
  const riskBand = bandFromPublic(risk.dist, 'risk');
  const authBand = bandFromPublic(auth.dist, 'authorization');
  const riskClass =
    riskBand <= LOW_RISK_MAX ? 'low' : riskBand >= 9 ? 'high' : 'medium';
  const authClass =
    authBand >= 8 ? 'explicit' : authBand >= 5 ? 'implied' : 'none';

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
