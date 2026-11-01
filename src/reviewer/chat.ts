import { CredentialRedactor } from './credential-redactor.js';
import {
  bindPreparedReviewRequest,
  isPreparedReviewRequest,
  reviewRequestCopy,
} from './prepared-request.js';
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
import {
  attemptIdOf,
  type AttemptFailureKind,
  type ReviewAttempt,
} from './attempt.js';
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
  readonly redactor?: CredentialRedactor;
  readonly llm: LlmLike;
  readonly session?: SessionLike;
  readonly chat: ChatReviewerConfig;
  readonly signal: AbortSignal;
  /** Omitted to inherit the host's own chain; see {@link StreamOptionsLike}. */
  readonly reasoningEffort?: string;
  /**
   * How to read one answer, or omitted for the production reader.
   *
   * The one thing an experiment may substitute. It is a function rather than a flag so
   * the production path has no branch to take: absent means `readChatAnswer`, and a
   * candidate B package passes a wrapper that removes its extra member first. The parser
   * of the two score members is still the production one in either case.
   */
  readonly readAnswer?: (text: string) => ParsedAnswer;
}

/** One review's chat outcome: the attempts made and the answer that read. */
export interface ChatTransportResult {
  readonly attempts: readonly ReviewAttempt[];
  /** The first answer that satisfied the contract, or null when none did. */
  readonly answer: (ParsedAnswer & { readonly ok: true }) | null;
  /**
   * The last unreadable answer, which may still hold one readable field.
   *
   * Kept so a failed review can report which half the reviewer got right instead
   * of collapsing every failure into "no score".
   */
  readonly rejection: (ParsedAnswer & { readonly ok: false }) | null;
  /** Why no attempt produced a usable answer, when none did. */
  readonly error: string | null;
  /** No chat credential is known here; the host's LLM service owns it. */
  readonly secrets: readonly string[];
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

function retainedChatRequest(
  request: ChatRequest,
  redactor: CredentialRedactor,
): ChatRequest {
  const retained = reviewRequestCopy(request, redactor);
  if (retained === null || typeof retained !== 'object')
    throw new Error('prepared chat material could not be safely retained');
  const system: unknown = Reflect.get(retained, 'system');
  const user: unknown = Reflect.get(retained, 'user');
  if (typeof system !== 'string' || typeof user !== 'string')
    throw new Error('prepared chat material could not be safely retained');
  const copy = { ...request, system, user };
  bindPreparedReviewRequest(copy, redactor, () =>
    retainedChatRequest(request, redactor),
  );
  return copy;
}

function retainedChatAttempt(
  request: ChatRequest,
  messages: StreamOptionsLike['messages'],
  redactor: CredentialRedactor,
): { readonly system: string; readonly messages: unknown } {
  return {
    system: retainedChatRequest(request, redactor).system,
    messages: reviewRequestCopy(messages, redactor),
  };
}

function preparedChatMessages(
  request: ChatRequest,
  repair: string | null,
  redactor: CredentialRedactor,
): StreamOptionsLike['messages'] {
  const copy = () =>
    chatMessages(
      retainedChatRequest(request, redactor).user,
      repair === null ? null : redactor.text(repair, true),
    );
  const messages = copy();
  bindPreparedReviewRequest(messages, redactor, copy);
  return messages;
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
  readonly failureKind: AttemptFailureKind | null;
  readonly rawUsage: unknown;
  readonly redactor: CredentialRedactor;
}): ReviewAttempt {
  const frozenRequest = {
    provider: options.route.provider,
    model: options.route.model,
    system: options.request.system,
    messages: options.messages,
  };
  bindPreparedReviewRequest(
    frozenRequest,
    options.redactor,
    () => ({
      ...frozenRequest,
      ...retainedChatAttempt(
        options.request,
        options.messages,
        options.redactor,
      ),
    }),
    options.messages,
  );
  return {
    attemptId: attemptIdOf(options.callId, options.attempt + 1),
    callId: options.callId,
    attempt: options.attempt + 1,
    backend: 'chat',
    protocol: CHAT_PROTOCOL,
    request: frozenRequest,
    responseText: options.responseText,
    parsed: options.parsed,
    error: options.error,
    failureKind: options.failureKind,
    startedAt: options.startedAt,
    durationMs: Date.now() - options.startedAt,
    estimatedInputTokens: options.request.estimatedInputTokens,
    rawUsage: options.rawUsage,
    normalizedUsage: normalizeUsage('chat', options.rawUsage),
  };
}

/** The transport outcome when the route itself cannot be resolved. */
function routeFailure(error: string): ChatTransportResult {
  return { attempts: [], answer: null, rejection: null, error, secrets: [] };
}

/**
 * One attempt's failed record, and why it ended the call.
 *
 * Separated from the loop so the loop's own branching stays about control flow: this
 * function is the one place a transport failure is described, and it is deliberately the
 * only place that reads `ChatStreamError`'s fields.
 */
function transportFailure(parts: {
  readonly redactor: CredentialRedactor;
  readonly error: unknown;
  readonly callId: string;
  readonly attempt: number;
  readonly route: ChatRoute;
  readonly request: ChatRequest;
  readonly messages: StreamOptionsLike['messages'];
  readonly startedAt: number;
  readonly timedOut: boolean;
  readonly timeoutMs: number;
}): { readonly attempt: ReviewAttempt; readonly failure: string } {
  const message =
    parts.error instanceof Error ? parts.error.message : String(parts.error);
  // A provider may abort for its own reasons, so the timer's own state — not the error's
  // name — is what proves this attempt timed out.
  const failure = parts.timedOut
    ? `reviewer request timed out after ${String(parts.timeoutMs)}ms`
    : message;
  const streamError =
    parts.error instanceof ChatStreamError ? parts.error : null;
  return {
    failure,
    attempt: attemptRecord({
      redactor: parts.redactor,
      callId: parts.callId,
      attempt: parts.attempt,
      route: parts.route,
      request: parts.request,
      messages: parts.messages,
      startedAt: parts.startedAt,
      responseText: null,
      parsed: null,
      error: failure,
      // A stream that failed is a transport outcome unless the provider declared the
      // failure itself, which `ChatStreamError` records.
      failureKind: streamError === null ? 'transport' : streamError.kind,
      // A provider that fails its own call may still have reported usage before doing
      // so, and a billed failure is exactly the attempt an operator needs to see.
      // Nothing else about the failure is reused.
      rawUsage: streamError === null ? null : streamError.usage,
    }),
  };
}

export async function runChatTransport(
  ctx: ChatTransportContext,
  request: ChatRequest,
  callId: string,
): Promise<ChatTransportResult> {
  const redactor = ctx.redactor ?? new CredentialRedactor(`chat:${callId}`);
  if (!isPreparedReviewRequest(request, redactor)) {
    redactor.discover(request.system, true);
    redactor.discover(request.user);
    request = {
      ...request,
      system: redactor.text(request.system, true),
      user: redactor.text(request.user),
    };
    bindPreparedReviewRequest(request, redactor);
  }
  let route: ChatRoute;
  try {
    route = chatRoute(ctx.chat, ctx.session);
  } catch (error) {
    return routeFailure(error instanceof Error ? error.message : String(error));
  }
  const readAnswer = ctx.readAnswer ?? readChatAnswer;
  const attempts: ReviewAttempt[] = [];
  let repair: string | null = null;
  let rejection: (ParsedAnswer & { readonly ok: false }) | null = null;
  const maxAttempts = 1 + ctx.chat.maxRepairRetries;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const current = retainedChatRequest(request, redactor);
    const messages = preparedChatMessages(request, repair, redactor);
    const attemptTimeout = AbortSignal.timeout(ctx.chat.timeoutMs);
    const attemptSignal = AbortSignal.any([ctx.signal, attemptTimeout]);
    const options = streamOptions(route, current, messages, ctx, attemptSignal);
    try {
      const collected = await collectChatText(ctx.llm.stream(options));
      const answer = readAnswer(collected.text);
      redactor.discover(collected.text, true);
      redactor.discover(collected.usage);
      attempts.push(
        attemptRecord({
          redactor,
          callId,
          attempt,
          route,
          request: current,
          messages,
          startedAt,
          responseText: collected.text,
          parsed: answer.ok ? answer.raw : null,
          error: answer.ok ? null : answer.error,
          // An answer arrived; only its shape failed the contract.
          failureKind: answer.ok ? null : 'unreadable-answer',
          rawUsage: collected.usage,
        }),
      );
      if (answer.ok) {
        return { attempts, answer, rejection: null, error: null, secrets: [] };
      }
      repair = answer.error;
      rejection = answer;
    } catch (error) {
      const failed = transportFailure({
        redactor,
        error,
        callId,
        attempt,
        route,
        request: current,
        messages,
        startedAt,
        timedOut: attemptTimeout.aborted && !ctx.signal.aborted,
        timeoutMs: ctx.chat.timeoutMs,
      });
      attempts.push(failed.attempt);
      // Provider failures are not retried; only format failures are.
      return {
        attempts,
        answer: null,
        rejection,
        error: failed.failure,
        secrets: [],
      };
    }
  }
  return {
    attempts,
    answer: null,
    rejection,
    error: `reviewer output remained invalid after ${String(maxAttempts)} attempts: ${repair ?? 'unknown error'}`,
    secrets: [],
  };
}
