import type {
  ArbiterConfig,
  ModelAttemptRecord,
  ModelResult,
  PolicyThresholds,
  ReviewSnapshot,
} from '../types.js';
import { buildQuestions, renderDecisionState } from './prompt.js';
import { parseDecisionResponse } from './signals.js';
import { redact, redactValue } from './redact.js';

interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>;
}

export interface DecisionRunContext {
  readonly fetch: typeof fetch;
  readonly credentials: CredentialsLike | undefined;
  /**
   * A value the caller already resolved for this exact run.
   *
   * Passing it keeps the sent credential and the redaction target identical;
   * omitting it makes the backend resolve the reference itself.
   */
  readonly preResolvedCredential?: { readonly value: string } | undefined;
  readonly decision: ArbiterConfig['reviewer']['decision'];
  readonly thresholds: PolicyThresholds;
  readonly signal: AbortSignal;
}

/**
 * The credential this call sends.
 *
 * `resolve` is called at most once per run. A caller that has already resolved
 * the reference passes the value through `preResolved`, so the same secret
 * authenticates the request and is the one available for redaction — a value
 * resolved twice could differ when a credential rotates mid-run.
 */
async function decisionCredential(
  ctx: DecisionRunContext & {
    readonly preResolved?: { readonly value: string } | undefined;
  },
): Promise<string | undefined> {
  if (ctx.decision.apiKeyRef.length === 0) return undefined;
  let credential: string | undefined;
  try {
    credential =
      ctx.preResolved !== undefined
        ? ctx.preResolved.value
        : (await ctx.credentials?.resolve(ctx.decision.apiKeyRef))?.value;
  } catch {
    // The resolver's own message may quote the stored value; the failure is the
    // stage, and the stage is all a record needs.
    throw new Error(
      `credential "${ctx.decision.apiKeyRef}" could not be resolved`,
    );
  }
  if (credential === undefined) {
    throw new Error(`credential "${ctx.decision.apiKeyRef}" is not configured`);
  }
  return credential;
}

interface ResponseContext {
  readonly recordBase: Omit<
    ModelAttemptRecord,
    'responseText' | 'parsed' | 'error' | 'usage'
  >;
  readonly attempts: ModelAttemptRecord[];
  readonly thresholds: PolicyThresholds;
  readonly secrets: readonly string[];
}

function decisionResponseResult(
  response: Response,
  text: string,
  ctx: ResponseContext,
): ModelResult {
  const { recordBase, attempts, thresholds, secrets } = ctx;
  // The complete body is retained because a clipped response cannot be
  // re-read later, but retention never outranks the credential boundary: the
  // audit writer stores this field verbatim and call details serve it back, so
  // the one value known to be sensitive is removed here.
  const responseText = redact(text, secrets);
  if (!response.ok) {
    // A refusal can still carry both a JSON explanation and the bill for the
    // attempt; read the body once and take whichever of the two it supplied.
    let refusal: unknown;
    try {
      refusal = JSON.parse(text);
    } catch {
      // Not JSON: the status is all this refusal said.
    }
    const error = failureText(
      response.status,
      providerExplanation(refusal),
      secrets,
    );
    attempts.push({
      ...recordBase,
      responseText,
      parsed: null,
      error,
      usage: reportedUsage(refusal, secrets),
    });
    return { ok: false, kind: 'review-failure', error, attempts };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch {
    // The library message quotes the input text, which is provider output and
    // may echo anything it received; the fact of the failure is all a record
    // needs, and the field is bounded rather than quoting the body.
    const error = 'response is not valid JSON';
    attempts.push({
      ...recordBase,
      responseText,
      parsed: null,
      error,
      usage: null,
    });
    return { ok: false, kind: 'review-failure', error, attempts };
  }
  // A provider that answered with an error is not answering the question, even
  // when it also filled the answer fields. The flag decides, not the payload's
  // completeness, because the payload is still being formed on failure paths.
  if (record(parsedBody) && parsedBody['success'] === false) {
    const error = failureText(
      response.status,
      providerExplanation(parsedBody),
      secrets,
    );
    attempts.push({
      ...recordBase,
      responseText,
      parsed: null,
      error,
      usage: reportedUsage(parsedBody, secrets),
    });
    return { ok: false, kind: 'review-failure', error, attempts };
  }
  const usage = reportedUsage(parsedBody, secrets);
  const parsed = parseDecisionResponse(parsedBody, thresholds);
  attempts.push({
    ...recordBase,
    responseText,
    parsed: parsed.ok ? parsed.signals : null,
    error: parsed.ok ? null : parsed.error,
    usage,
  });
  if (!parsed.ok) {
    return {
      ok: false,
      kind: 'review-failure',
      error: parsed.error,
      attempts,
    };
  }
  return { ok: true, signals: parsed.signals, attempts };
}

/**
 * The request envelope this endpoint expects.
 *
 * The two vendors agree on the question/answer vocabulary but not on the HTTP
 * body. The distinction is a property of the *entry point*, not of the vendor:
 *
 *   POST /accounts/{acct}/ai/run/@cf/cloudflare/{model}   flat   {model,state,questions}
 *   POST /accounts/{acct}/ai/run                          wrapped {model,input:{state,questions}}
 *   POST https://api.typesafe.ai/v1/systemone             flat   {model,state,questions}
 *
 * The generic Cloudflare entry is the only wrapped one, and its pathname ends
 * in `/ai/run`. Every other path keeps the flat body — including an endpoint
 * this plugin has never seen, because a custom compatible service was
 * addressable before and must stay addressable. A URL that cannot be parsed
 * also stays flat: guessing a wrapper from an unknown string would change the
 * request without evidence.
 */
function decisionRequestShape(url: string): 'flat' | 'wrapped' {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return 'flat';
  }
  return /\/ai\/run\/?$/u.test(pathname) ? 'wrapped' : 'flat';
}

/** The longest provider explanation kept in a record. */
const MAX_EXPLANATION = 300;

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

/**
 * The explanation a provider supplied, if it supplied one.
 *
 * The three documented shapes are Cloudflare's `errors[].message`, a plain
 * `error.message`, and TypeSafe's `detail.message`. Only those fields are read:
 * a failure must never carry request state, tool output, file content, or the
 * whole body into a record that is shown to a person and stored.
 */
function providerExplanation(parsed: unknown): string | null {
  if (!record(parsed)) return null;
  const errors = parsed['errors'];
  if (Array.isArray(errors)) {
    for (const entry of errors) {
      const message = record(entry) ? text(entry['message']) : null;
      if (message !== null) return message;
    }
  }
  for (const key of ['error', 'detail'] as const) {
    const nested = parsed[key];
    const message = record(nested) ? text(nested['message']) : null;
    if (message !== null) return message;
    const direct = text(nested);
    if (direct !== null) return direct;
  }
  return null;
}

/**
 * The one error string this attempt reports, in both places it is consumed.
 *
 * `HTTP <status>` stays the exact prefix: the connection test classifies a
 * failure by matching it, and a rewritten prefix would turn an authentication
 * failure into an unclassified one. The explanation follows the prefix, so an
 * explanation is additive rather than a replacement.
 */
function failureText(
  status: number,
  explanation: string | null,
  secrets: readonly string[],
): string {
  const base = `HTTP ${String(status)}`;
  if (explanation === null) return base;
  // Mask before bounding: truncating first can cut a credential in half, and a
  // half is no longer an exact-value match, so the visible prefix would survive
  // the mask that was supposed to remove it.
  const masked = redact(explanation, secrets);
  const bounded =
    masked.length > MAX_EXPLANATION
      ? `${masked.slice(0, MAX_EXPLANATION)}…`
      : masked;
  return `${base}: ${bounded}`;
}

/**
 * The `usage` a provider reported, masked before it can be stored.
 *
 * Usage is read whether or not the response produced a verdict: a provider that
 * reports a failure was still billed for the request, and that is exactly when
 * the caller most wants the count. Cloudflare nests the payload under `result`,
 * a native endpoint answers at the root, and both put `usage` beside `answers`.
 */
function reportedUsage(parsed: unknown, secrets: readonly string[]): unknown {
  if (!record(parsed)) return null;
  const payload = record(parsed['result']) ? parsed['result'] : parsed;
  const usage = payload['usage'];
  if (usage === undefined) return null;
  return redactValue(usage, secrets);
}

export async function runDecisionReviewer(
  ctx: DecisionRunContext,
  _snapshot: ReviewSnapshot,
  request: { readonly user: string; readonly estimatedInputTokens: number },
  callId: string,
): Promise<ModelResult> {
  const attempts: ModelAttemptRecord[] = [];
  const startedAt = Date.now();
  let credential: string | undefined;
  try {
    credential = await decisionCredential({
      ...ctx,
      ...(ctx.preResolvedCredential === undefined
        ? {}
        : { preResolved: ctx.preResolvedCredential }),
    });
  } catch (error) {
    return {
      ok: false,
      kind: 'review-failure',
      error: error instanceof Error ? error.message : String(error),
      attempts,
    };
  }
  if (ctx.decision.url.length === 0) {
    return {
      ok: false,
      kind: 'review-failure',
      error: 'decision backend URL is empty',
      attempts,
    };
  }
  const state = renderDecisionState(request.user);
  const questions = buildQuestions();
  // The same material in the envelope this endpoint reads. The flat body is the
  // default because two of the three known entries take it; only the generic
  // Cloudflare entry wraps, and its pathname says so.
  const body =
    decisionRequestShape(ctx.decision.url) === 'wrapped'
      ? { model: ctx.decision.model, input: { state, questions } }
      : { model: ctx.decision.model, state, questions };
  const timeout = AbortSignal.timeout(ctx.decision.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  try {
    const response = await ctx.fetch(ctx.decision.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(credential === undefined
          ? {}
          : { authorization: `Bearer ${credential}` }),
      },
      body: JSON.stringify(body),
      signal,
    });
    const text = await response.text();
    const recordBase = {
      requestId: `${callId}:model:1`,
      callId,
      attempt: 1,
      backend: 'decision' as const,
      protocol: 'arbiter-decision-v1',
      request: body,
      startedAt,
      durationMs: Date.now() - startedAt,
      estimatedInputTokens: request.estimatedInputTokens,
    };
    return decisionResponseResult(response, text, {
      recordBase,
      attempts,
      thresholds: ctx.thresholds,
      secrets: credential === undefined ? [] : [credential],
    });
  } catch (caught) {
    const raw = caught instanceof Error ? caught.message : String(caught);
    // A transport error is arbitrary text from below this layer, and it may
    // quote the header the request used. This is the one place the credential
    // is known, so the known value is removed here rather than trusting the
    // transport's phrasing.
    const secrets = credential === undefined ? [] : [credential];
    const message = redact(raw, secrets);
    attempts.push({
      requestId: `${callId}:model:1`,
      callId,
      attempt: 1,
      backend: 'decision',
      protocol: 'arbiter-decision-v1',
      request: body,
      responseText: null,
      parsed: null,
      error: message,
      startedAt,
      durationMs: Date.now() - startedAt,
      estimatedInputTokens: request.estimatedInputTokens,
      usage: null,
    });
    return {
      ok: false,
      kind: 'review-failure',
      error: timeout.aborted ? 'decision backend timed out' : message,
      attempts,
    };
  }
}
