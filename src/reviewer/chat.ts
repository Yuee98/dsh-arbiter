/**
 * The chat transport: one review's attempts through the host's LLM service.
 *
 * This module moves bytes and nothing else. It renders nothing (the request
 * arrives rendered), scores nothing (the caller reads the answer through the
 * shared contract) and decides nothing. Two behaviours are its own:
 *
 *   - a format failure is repaired, a transport failure is not. Re-asking fixes
 *     "the JSON was malformed"; it cannot fix "the provider refused", and
 *     retrying the second spends money to learn nothing.
 *   - an attempt keeps whatever the provider reported, including on a failure,
 *     because a refused request was still billed.
 *
 * The per-attempt timeout is the adapter's own outcome, kept apart from the
 * caller's lifetime: reporting a timeout as a caller cancellation would tell the
 * operator the wrong thing.
 */

import type { ChatReviewerConfig } from '../types.js';
import { attemptIdOf, type ReviewAttempt } from './attempt.js';
import {
  ChatStreamError,
  chatRoute,
  collectChatText,
  type ChatRoute,
  type LlmLike,
  type SessionLike,
  type StreamOptionsLike,
} from './llm.js';
import { normalizeUsage } from './usage.js';
import { CHAT_PROTOCOL } from './contract.js';
import type { ChatRequest } from './prompt.js';
import { readChatAnswer, type ParsedAnswer } from './signals.js';

export interface ChatTransportContext {
  readonly llm: LlmLike;
  readonly session?: SessionLike;
  readonly chat: ChatReviewerConfig;
  readonly signal: AbortSignal;
  /** Omitted to inherit the host's own chain; see {@link StreamOptionsLike}. */
  readonly reasoningEffort?: string;
}

/** One review's chat outcome: the attempts made and the answer that read. */
export interface ChatTransportResult {
  readonly attempts: readonly ReviewAttempt[];
  /** The first answer that satisfied the contract, or null when none did. */
  readonly answer: (ParsedAnswer & { readonly ok: true }) | null;
  /** Why no attempt produced a usable answer, when none did. */
  readonly error: string | null;
}

function chatMessages(
  user: string,
  repair: string | null,
): StreamOptionsLike['messages'] {
  const base: StreamOptionsLike['messages'] = [
    { role: 'user', content: [{ type: 'text', text: user }] },
  ];
  if (repair === null) return base;
  return [
    ...base,
    {
      role: 'user',
      content: [
        {
          type: 'text',
          text: `Your previous answer was rejected: ${repair}\nReturn only the corrected JSON object.`,
        },
      ],
    },
  ];
}

/**
 * The options for one attempt.
 *
 * `reasoningEffort` is added only when the caller supplied one: the key must be
 * absent, not `undefined`, because the host falls back to its own chain when it
 * is missing and would otherwise treat an explicit value as a decision.
 */
function streamOptions(
  route: ChatRoute,
  request: ChatRequest,
  messages: StreamOptionsLike['messages'],
  ctx: ChatTransportContext,
  signal: AbortSignal,
): StreamOptionsLike {
  const base: StreamOptionsLike = {
    provider: route.provider,
    model: route.model,
    system: request.system,
    messages,
    temperature: ctx.chat.temperature,
    maxTokens: ctx.chat.maxTokens,
    signal,
  };
  return ctx.reasoningEffort === undefined
    ? base
    : { ...base, reasoningEffort: ctx.reasoningEffort };
}

/** The attempt record for one stream, successful or not. */
function attemptRecord(options: {
  readonly callId: string;
  readonly attempt: number;
  readonly route: ChatRoute;
  readonly request: ChatRequest;
  readonly messages: StreamOptionsLike['messages'];
  readonly startedAt: number;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
  readonly rawUsage: unknown;
}): ReviewAttempt {
  return {
    attemptId: attemptIdOf(options.callId, options.attempt + 1),
    callId: options.callId,
    attempt: options.attempt + 1,
    backend: 'chat',
    protocol: CHAT_PROTOCOL,
    request: {
      provider: options.route.provider,
      model: options.route.model,
      system: options.request.system,
      messages: options.messages,
    },
    responseText: options.responseText,
    parsed: options.parsed,
    error: options.error,
    startedAt: options.startedAt,
    durationMs: Date.now() - options.startedAt,
    estimatedInputTokens: options.request.estimatedInputTokens,
    rawUsage: options.rawUsage,
    normalizedUsage: normalizeUsage('chat', options.rawUsage),
  };
}

/** The transport outcome when the route itself cannot be resolved. */
function routeFailure(error: string): ChatTransportResult {
  return { attempts: [], answer: null, error };
}

export async function runChatTransport(
  ctx: ChatTransportContext,
  request: ChatRequest,
  callId: string,
): Promise<ChatTransportResult> {
  let route: ChatRoute;
  try {
    route = chatRoute(ctx.chat, ctx.session);
  } catch (error) {
    return routeFailure(error instanceof Error ? error.message : String(error));
  }

  const attempts: ReviewAttempt[] = [];
  let repair: string | null = null;
  const maxAttempts = 1 + ctx.chat.maxRepairRetries;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const messages = chatMessages(request.user, repair);
    const attemptTimeout = AbortSignal.timeout(ctx.chat.timeoutMs);
    const attemptSignal = AbortSignal.any([ctx.signal, attemptTimeout]);
    const options = streamOptions(route, request, messages, ctx, attemptSignal);
    try {
      const collected = await collectChatText(ctx.llm.stream(options));
      const answer = readChatAnswer(collected.text);
      attempts.push(
        attemptRecord({
          callId,
          attempt,
          route,
          request,
          messages,
          startedAt,
          responseText: collected.text,
          parsed: answer.ok ? answer.raw : null,
          error: answer.ok ? null : answer.error,
          rawUsage: collected.usage,
        }),
      );
      if (answer.ok) return { attempts, answer, error: null };
      repair = answer.error;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A provider may abort for its own reasons, so the timer's own state — not
      // the error's name — is what proves this attempt timed out.
      const failure =
        attemptTimeout.aborted && !ctx.signal.aborted
          ? `reviewer request timed out after ${String(ctx.chat.timeoutMs)}ms`
          : message;
      attempts.push(
        attemptRecord({
          callId,
          attempt,
          route,
          request,
          messages,
          startedAt,
          responseText: null,
          parsed: null,
          error: failure,
          // A provider that fails its own call may still have reported usage
          // before doing so, and a billed failure is exactly the attempt an
          // operator needs to see. Nothing else about the failure is reused.
          rawUsage: error instanceof ChatStreamError ? error.usage : null,
        }),
      );
      // Provider failures are not retried; only format failures are.
      return { attempts, answer: null, error: failure };
    }
  }
  return {
    attempts,
    answer: null,
    error: `reviewer output remained invalid after ${String(maxAttempts)} attempts: ${repair ?? 'unknown error'}`,
  };
}
