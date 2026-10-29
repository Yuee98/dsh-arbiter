/**
 * The decision transport: one HTTP request to a native or Cloudflare endpoint.
 *
 * Like the chat transport, this module moves bytes and reports what happened. The
 * envelope, the explanation fields and the redaction boundary come from
 * `envelope.ts` and `redact.ts` so the two reviewer paths cannot describe the same
 * provider differently.
 *
 * The one asymmetric rule is the refusal: `success: false` is a failure on its own,
 * even when the payload also carries complete answers, because a provider that
 * reports failure is still forming its answer. A native endpoint has no `success`
 * field at all, so its absence means nothing.
 */

import type { ArbiterConfig } from '../types.js';
import { attemptIdOf, type ReviewAttempt } from './attempt.js';
import {
  failureText,
  providerExplanation,
  reportedUsage,
  requestShapeOf,
} from './envelope.js';
import { DECISION_PROTOCOL } from './contract.js';
import type { DecisionRequest } from './prompt.js';
import { redact } from './redact.js';
import { readDecisionAnswer, type ParsedAnswer } from './signals.js';
import { normalizeUsage } from './usage.js';

interface CredentialsLike {
  resolve(ref: string): Promise<{ readonly value: string } | undefined>;
}

export interface DecisionTransportContext {
  readonly fetch: typeof fetch;
  readonly credentials: CredentialsLike | undefined;
  /**
   * A value the caller already resolved for this exact run.
   *
   * Passing it keeps the sent credential and the redaction target identical;
   * omitting it makes the transport resolve the reference itself.
   */
  readonly preResolvedCredential?: { readonly value: string } | undefined;
  readonly decision: ArbiterConfig['reviewer']['decision'];
  readonly signal: AbortSignal;
}

/** One review's decision outcome. */
export interface DecisionTransportResult {
  readonly attempts: readonly ReviewAttempt[];
  readonly answer: (ParsedAnswer & { readonly ok: true }) | null;
  readonly error: string | null;
}

/**
 * The credential this call sends.
 *
 * `resolve` is called at most once per run. A caller that has already resolved
 * the reference passes the value through `preResolvedCredential`, so the same
 * secret authenticates the request and is the one available for redaction — a
 * value resolved twice could differ when a credential rotates mid-run.
 */
async function decisionCredential(
  ctx: DecisionTransportContext,
): Promise<string | undefined> {
  if (ctx.decision.apiKeyRef.length === 0) return undefined;
  let credential: string | undefined;
  try {
    credential =
      ctx.preResolvedCredential !== undefined
        ? ctx.preResolvedCredential.value
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

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The request body this endpoint reads. */
function requestBody(
  decision: ArbiterConfig['reviewer']['decision'],
  request: DecisionRequest,
): unknown {
  // The flat body is the default because two of the three known entries take it;
  // only the generic Cloudflare entry wraps, and its pathname says so.
  return requestShapeOf(decision.url) === 'wrapped'
    ? {
        model: decision.model,
        input: { state: request.state, questions: request.questions },
      }
    : {
        model: decision.model,
        state: request.state,
        questions: request.questions,
      };
}

/** The record shared by every path that got as far as sending a request. */
function attemptBase(options: {
  readonly callId: string;
  readonly request: DecisionRequest;
  readonly body: unknown;
  readonly startedAt: number;
}): Omit<
  ReviewAttempt,
  'responseText' | 'parsed' | 'error' | 'rawUsage' | 'normalizedUsage'
> {
  return {
    attemptId: attemptIdOf(options.callId, 1),
    callId: options.callId,
    attempt: 1,
    backend: 'decision',
    protocol: DECISION_PROTOCOL,
    request: options.body,
    startedAt: options.startedAt,
    durationMs: Date.now() - options.startedAt,
    estimatedInputTokens: options.request.estimatedInputTokens,
  };
}

/** The outcome for a body that arrived but could not be read as an answer. */
function unreadableOutcome(options: {
  readonly base: ReturnType<typeof attemptBase>;
  readonly responseText: string;
  readonly error: string;
  readonly rawUsage: unknown;
}): DecisionTransportResult {
  return {
    attempts: [
      {
        ...options.base,
        responseText: options.responseText,
        parsed: null,
        error: options.error,
        rawUsage: options.rawUsage,
        normalizedUsage: normalizeUsage('decision', options.rawUsage),
      },
    ],
    answer: null,
    error: options.error,
  };
}

/**
 * Read one HTTP response into an attempt.
 *
 * `secrets` is what the caller knows was sent; the complete body is retained for
 * diagnosis but never carries that value out.
 */
function readResponse(options: {
  readonly response: Response;
  readonly text: string;
  readonly base: ReturnType<typeof attemptBase>;
  readonly secrets: readonly string[];
}): DecisionTransportResult {
  const { response, base, secrets } = options;
  const responseText = redact(options.text, secrets);
  if (!response.ok) {
    let refusal: unknown;
    try {
      refusal = JSON.parse(options.text);
    } catch {
      // Not JSON: the status is all this refusal said.
    }
    const error = failureText(
      response.status,
      providerExplanation(refusal),
      secrets,
    );
    return unreadableOutcome({
      base,
      responseText,
      error,
      rawUsage: reportedUsage(refusal, secrets),
    });
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(options.text);
  } catch {
    // The library message quotes the input, which is provider output and may echo
    // anything it received; the fact of the failure is all a record needs.
    return unreadableOutcome({
      base,
      responseText,
      error: 'response is not valid JSON',
      rawUsage: null,
    });
  }
  const rawUsage = reportedUsage(parsedBody, secrets);
  // A provider that answered with an error is not answering the question, even
  // when it also filled the answer fields.
  if (record(parsedBody) && parsedBody['success'] === false) {
    return unreadableOutcome({
      base,
      responseText,
      error: failureText(
        response.status,
        providerExplanation(parsedBody),
        secrets,
      ),
      rawUsage,
    });
  }
  const answer = readDecisionAnswer(parsedBody);
  if (!answer.ok) {
    return unreadableOutcome({
      base,
      responseText,
      error: answer.error,
      rawUsage,
    });
  }
  return {
    attempts: [
      {
        ...base,
        responseText,
        parsed: answer.raw,
        error: null,
        rawUsage,
        normalizedUsage: normalizeUsage('decision', rawUsage),
      },
    ],
    answer,
    error: null,
  };
}

export async function runDecisionTransport(
  ctx: DecisionTransportContext,
  request: DecisionRequest,
  callId: string,
): Promise<DecisionTransportResult> {
  let credential: string | undefined;
  try {
    credential = await decisionCredential(ctx);
  } catch (error) {
    return {
      attempts: [],
      answer: null,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (ctx.decision.url.length === 0) {
    return {
      attempts: [],
      answer: null,
      error: 'decision backend URL is empty',
    };
  }
  const body = requestBody(ctx.decision, request);
  const timeout = AbortSignal.timeout(ctx.decision.timeoutMs);
  const signal = AbortSignal.any([ctx.signal, timeout]);
  const startedAt = Date.now();
  const base = attemptBase({ callId, request, body, startedAt });
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
    return readResponse({
      response,
      text,
      base: { ...base, durationMs: Date.now() - startedAt },
      secrets: credential === undefined ? [] : [credential],
    });
  } catch (caught) {
    const raw = caught instanceof Error ? caught.message : String(caught);
    // A transport error is arbitrary text from below this layer, and it may quote
    // the header the request used. This is the one place the credential is known,
    // so the known value is removed here rather than trusting the transport.
    const secrets = credential === undefined ? [] : [credential];
    const message = redact(raw, secrets);
    return {
      attempts: [
        {
          ...base,
          responseText: null,
          parsed: null,
          error: message,
          rawUsage: null,
          normalizedUsage: null,
        },
      ],
      answer: null,
      error: timeout.aborted ? 'decision backend timed out' : message,
    };
  }
}
