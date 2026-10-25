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
  readonly signal?: AbortSignal;
}

export interface LlmLike {
  stream(options: StreamOptionsLike): AsyncIterable<Record<string, unknown>>;
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
    startedAt,
    durationMs: Date.now() - startedAt,
    estimatedInputTokens: request.estimatedInputTokens,
  };
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
    const attemptSignal = AbortSignal.any([
      ctx.signal,
      AbortSignal.timeout(ctx.chat.timeoutMs),
    ]);
    const options: StreamOptionsLike = {
      provider: route.provider,
      model: route.model,
      system: request.system,
      messages,
      temperature: ctx.chat.temperature,
      maxTokens: ctx.chat.maxTokens,
      signal: attemptSignal,
    };
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
        error: message,
        usage: null,
      });
      // Provider failures are not retried; only format/schema repair is.
      return { ok: false, kind: 'review-failure', error: message, attempts };
    }
  }
  return {
    ok: false,
    kind: 'review-failure',
    error: `reviewer output remained invalid after ${String(maxAttempts)} attempts: ${repair ?? 'unknown error'}`,
    attempts,
  };
}
