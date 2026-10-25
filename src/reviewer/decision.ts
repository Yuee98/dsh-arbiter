import type {
  ArbiterConfig,
  ModelAttemptRecord,
  ModelResult,
  PolicyThresholds,
  ReviewSnapshot,
} from '../types.js';
import { buildQuestions, renderDecisionState } from './prompt.js';
import { parseDecisionResponse } from './signals.js';

interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>;
}

export interface DecisionRunContext {
  readonly fetch: typeof fetch;
  readonly credentials: CredentialsLike | undefined;
  readonly decision: ArbiterConfig['reviewer']['decision'];
  readonly thresholds: PolicyThresholds;
  readonly signal: AbortSignal;
}

async function decisionCredential(
  ctx: DecisionRunContext,
): Promise<string | undefined> {
  if (ctx.decision.apiKeyRef.length === 0) return undefined;
  let credential: string | undefined;
  try {
    credential = (await ctx.credentials?.resolve(ctx.decision.apiKeyRef))
      ?.value;
  } catch (error) {
    throw new Error(
      `credential lookup failed: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
  if (credential === undefined) {
    throw new Error(`credential "${ctx.decision.apiKeyRef}" is not configured`);
  }
  return credential;
}

function decisionResponseResult(
  response: Response,
  text: string,
  recordBase: Omit<ModelAttemptRecord, 'responseText' | 'parsed' | 'error'>,
  attempts: ModelAttemptRecord[],
  thresholds: PolicyThresholds,
): ModelResult {
  if (!response.ok) {
    attempts.push({
      ...recordBase,
      responseText: text.slice(0, 8_000),
      parsed: null,
      error: `HTTP ${String(response.status)}`,
    });
    return {
      ok: false,
      kind: 'review-failure',
      error: `decision backend returned HTTP ${String(response.status)}`,
      attempts,
    };
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(text);
  } catch (error) {
    attempts.push({
      ...recordBase,
      responseText: text.slice(0, 8_000),
      parsed: null,
      error: `invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
    });
    return {
      ok: false,
      kind: 'review-failure',
      error: 'decision response is not valid JSON',
      attempts,
    };
  }
  const parsed = parseDecisionResponse(parsedBody, thresholds);
  attempts.push({
    ...recordBase,
    responseText: text.slice(0, 32_000),
    parsed: parsed.ok ? parsed.signals : null,
    error: parsed.ok ? null : parsed.error,
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

export async function runDecisionReviewer(
  ctx: DecisionRunContext,
  snapshot: ReviewSnapshot,
  request: { readonly user: string; readonly estimatedInputTokens: number },
  callId: string,
): Promise<ModelResult> {
  const attempts: ModelAttemptRecord[] = [];
  const startedAt = Date.now();
  let credential: string | undefined;
  try {
    credential = await decisionCredential(ctx);
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
  const body = {
    model: ctx.decision.model,
    state: renderDecisionState(snapshot, request.user),
    questions: buildQuestions(),
  };
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
      usage: null,
    };
    return decisionResponseResult(
      response,
      text,
      recordBase,
      attempts,
      ctx.thresholds,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
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
