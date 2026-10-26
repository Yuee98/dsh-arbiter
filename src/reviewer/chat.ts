import { templateIdOf } from '../audit/metadata.js';
import type {
  ChatReviewerConfig,
  ModelAttemptRecord,
  ModelResult,
  PolicyThresholds,
  ReviewSnapshot,
} from '../types.js';
import { parseChatText, signalsFromChat } from './signals.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface StreamOptionsLike {
  readonly provider: string;
  readonly model: string;
  readonly system: string;
  readonly messages: readonly {
    readonly role: 'user';
    readonly content: readonly {
      readonly type: 'text';
      readonly text: string;
    }[];
  }[];
  readonly temperature?: number;
  readonly maxTokens?: number;
  /**
   * Adapter-owned reasoning effort for this exact request.
   *
   * Omitted entirely when the caller has no opinion, because the host then
   * falls back to its own chain (`reasoningEffort ?? defaults.reasoningEffort
   * ?? thinking === "disabled" ? "off" : "high"`). Sending an explicit value
   * would silently override a deployment's choice.
   */
  readonly reasoningEffort?: string;
  readonly signal?: AbortSignal;
}

/** One provider route the host's LLM runtime currently serves. */
export interface LlmProviderLike {
  readonly id: string;
  readonly name: string;
}

/** One model an adapter advertises for its provider route. */
export interface LlmModelLike {
  readonly provider: string;
  readonly id: string;
  readonly name: string;
  readonly description?: string;
}

export interface LlmLike {
  stream(options: StreamOptionsLike): AsyncIterable<Record<string, unknown>>;
  /**
   * The read-only directory used by host model selectors.
   *
   * Both members are optional because a reviewer only needs `stream`: the
   * configuration page degrades to "no directory" instead of assuming every
   * composition exposes a catalog.
   */
  listProviders?(): readonly LlmProviderLike[];
  listModels?(provider: string): Promise<readonly LlmModelLike[]>;
}

interface SessionLike {
  requestHeader?():
    | {
        readonly config: { readonly provider: string; readonly model: string };
      }
    | undefined;
}

export async function collectChatText(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<{ readonly text: string; readonly usage: unknown }> {
  let text = '';
  let usage: unknown = null;
  let finished = false;
  for await (const chunk of stream) {
    const type = chunk['type'];
    if (type === 'text-delta' && typeof chunk['text'] === 'string') {
      text += chunk['text'];
      continue;
    }
    if (type === 'usage') {
      usage = chunk['usage'] ?? null;
      continue;
    }
    if (type === 'finish') {
      finished = true;
      const reason = chunk['reason'];
      if (isRecord(reason) && reason['kind'] !== 'stop') {
        const failure = isRecord(reason['failure']) ? reason['failure'] : {};
        const code = typeof failure['code'] === 'string' ? failure['code'] : '';
        const message =
          typeof failure['message'] === 'string' ? failure['message'] : '';
        throw new Error(
          `reviewer ended with ${String(reason['kind'])} ${code}: ${message}`,
        );
      }
    }
  }
  if (!finished) throw new Error('reviewer emitted no terminal finish');
  if (text.trim().length === 0) throw new Error('reviewer returned no text');
  return { text, usage };
}

function chatRoute(
  config: ChatReviewerConfig,
  session: SessionLike | undefined,
): {
  readonly provider: string;
  readonly model: string;
} {
  if (config.provider === 'session') {
    const header = session?.requestHeader?.();
    if (
      header === undefined ||
      header.config.provider.length === 0 ||
      header.config.model.length === 0
    ) {
      throw new Error(
        'no complete session request header; cannot use chat.provider "session"',
      );
    }
    return { provider: header.config.provider, model: header.config.model };
  }
  if (config.provider.length === 0 || config.model.length === 0) {
    throw new Error('chat reviewer requires provider and model');
  }
  return { provider: config.provider, model: config.model };
}

export interface ChatRunContext {
  readonly llm: LlmLike;
  readonly session?: SessionLike;
  readonly chat: ChatReviewerConfig;
  readonly thresholds: PolicyThresholds;
  readonly signal: AbortSignal;
  /**
   * Reasoning effort to request, or undefined to inherit the host's default.
   *
   * This is a capability, not a policy: nothing in the shipped configuration
   * sets it yet. Closing thinking is only safe once measurements show the
   * verdicts hold, so the default path stays "ask the host".
   */
  readonly reasoningEffort?: string;
}

interface ChatRequest {
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
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

function chatAttemptBase(
  callId: string,
  attempt: number,
  route: { readonly provider: string; readonly model: string },
  request: ChatRequest,
  messages: StreamOptionsLike['messages'],
  startedAt: number,
): Omit<ModelAttemptRecord, 'responseText' | 'parsed' | 'error' | 'usage'> {
  return {
    requestId: `${callId}:model:${String(attempt + 1)}`,
    callId,
    attempt: attempt + 1,
    backend: 'chat',
    protocol: 'arbiter-chat-json-v1',
    request: {
      provider: route.provider,
      model: route.model,
      system: request.system,
      messages,
    },
    // The system message *is* the reusable template. Its content identity lets
    // the audit record point at one immutable row instead of storing a copy per
    // attempt, and a later policy edit creates a new row rather than rewriting
    // what this decision was rendered from.
    templateId: templateIdOf(request.system),
    startedAt,
    durationMs: Date.now() - startedAt,
    estimatedInputTokens: request.estimatedInputTokens,
  };
}

/**
 * The one place a request leaves this adapter.
 *
 * `reasoningEffort` is added only when the caller supplied one: the key must be
 * absent, not `undefined`, because the host falls back to its own chain when it
 * is missing and would otherwise treat an explicit value as a decision.
 */
function streamOptions(
  route: { readonly provider: string; readonly model: string },
  request: ChatRequest,
  messages: StreamOptionsLike['messages'],
  ctx: ChatRunContext,
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

export async function runChatReviewer(
  ctx: ChatRunContext,
  _snapshot: ReviewSnapshot,
  request: ChatRequest,
  callId: string,
): Promise<ModelResult> {
  const attempts: ModelAttemptRecord[] = [];
  let route: { provider: string; model: string };
  try {
    route = chatRoute(ctx.chat, ctx.session);
  } catch (error) {
    return {
      ok: false,
      kind: 'review-failure',
      error: error instanceof Error ? error.message : String(error),
      attempts,
    };
  }

  let repair: string | null = null;
  const maxAttempts = 1 + ctx.chat.maxRepairRetries;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const startedAt = Date.now();
    const messages = chatMessages(request.user, repair);
    // Keep the attempt timer separate from the caller's lifetime: a timeout is
    // this adapter's own outcome, and reporting it as a caller cancellation
    // would tell the operator the wrong thing.
    const attemptTimeout = AbortSignal.timeout(ctx.chat.timeoutMs);
    const attemptSignal = AbortSignal.any([ctx.signal, attemptTimeout]);
    const options = streamOptions(route, request, messages, ctx, attemptSignal);
    try {
      const collected = await collectChatText(ctx.llm.stream(options));
      const parsed = parseChatText(collected.text);
      const record: ModelAttemptRecord = {
        ...chatAttemptBase(
          callId,
          attempt,
          route,
          request,
          messages,
          startedAt,
        ),
        responseText: collected.text,
        parsed: parsed.ok ? parsed.raw : null,
        error: parsed.ok ? null : (parsed.error ?? null),
        usage: collected.usage,
      };
      attempts.push(record);
      if (parsed.ok && parsed.raw !== undefined) {
        return {
          ok: true,
          signals: signalsFromChat(parsed.raw, attempt),
          attempts,
        };
      }
      repair = parsed.error ?? 'invalid reviewer output';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      // A provider may abort for its own reasons, so the timer's own state — not
      // the error's name — is what proves this attempt timed out.
      const failure =
        attemptTimeout.aborted && !ctx.signal.aborted
          ? `reviewer request timed out after ${String(ctx.chat.timeoutMs)}ms`
          : message;
      attempts.push({
        ...chatAttemptBase(
          callId,
          attempt,
          route,
          request,
          messages,
          startedAt,
        ),
        responseText: null,
        parsed: null,
        error: failure,
        usage: null,
      });
      // Provider failures are not retried; only format/schema repair is.
      return { ok: false, kind: 'review-failure', error: failure, attempts };
    }
  }
  return {
    ok: false,
    kind: 'review-failure',
    error: `reviewer output remained invalid after ${String(maxAttempts)} attempts: ${repair ?? 'unknown error'}`,
    attempts,
  };
}
