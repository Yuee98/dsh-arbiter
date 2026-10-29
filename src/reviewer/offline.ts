/**
 * Offline transports: the stand-in the acceptance evidence and the evals tooling
 * use instead of a paid provider call.
 *
 * The point is that it is *not* a shortcut around the production path. Both
 * variants plug into the same `review()` call the host will use, so the request is
 * rendered by the production renderer, the envelope is chosen by the production
 * rule, the body is read by the production parser and the usage is normalized by
 * the production mapping. Only the socket is replaced.
 *
 * The two variants mirror the two real seams exactly:
 *
 *   - chat replaces the host's `LlmLike`, because the host owns that socket.
 *   - decision replaces `fetch`, because this plugin owns that socket.
 *
 * A scripted response is returned once and then must be exhausted: a replay that
 * silently returns the last answer for every attempt would hide a repair loop that
 * never terminated.
 */

import type { ChatTransportContext } from './chat.js';
import type { DecisionTransportContext } from './decision.js';
import type { LlmLike, StreamOptionsLike } from './llm.js';
import type { DecisionBackend, ChatBackend } from './service.js';

/**
 * One scripted chat answer.
 *
 * Either text arrives (and the production parser reads it), or the stream ends in
 * a provider failure, which is the case a repair must not retry.
 */
export type OfflineChatScript =
  | {
      readonly kind: 'text';
      readonly text: string;
      /** The provider's usage chunk, if this answer carried one. */
      readonly usage?: unknown;
    }
  | {
      readonly kind: 'failure';
      readonly code: string;
      readonly message: string;
      /** Usage reported before the failure, when the provider sent any. */
      readonly usage?: unknown;
    }
  | {
      /** The stream ends with no terminal finish, as a dropped connection does. */
      readonly kind: 'truncated';
    };

/** One scripted decision response: an HTTP status and a body. */
export interface OfflineResponse {
  readonly status: number;
  /** The body text; a string is sent verbatim so a non-JSON body is expressible. */
  readonly body: string;
}

export type OfflineDecisionScript = OfflineResponse;

/** A chat transport backed by a scripted list of answers. */
export interface OfflineChatOptions {
  readonly scripts: readonly OfflineChatScript[];
  readonly provider?: string;
  readonly model?: string;
}

function streamOf(
  script: OfflineChatScript,
): AsyncIterable<Record<string, unknown>> {
  return (async function* () {
    await Promise.resolve();
    if (script.kind === 'truncated') {
      // No finish chunk at all: the production collector reports this as a
      // transport failure, which is exactly what a dropped stream is.
      yield { type: 'text-delta', text: '{"risk":' };
      return;
    }
    if (script.kind === 'failure') {
      if (script.usage !== undefined) {
        yield { type: 'usage', usage: script.usage };
      }
      yield {
        type: 'finish',
        reason: {
          kind: 'failure',
          failure: { code: script.code, message: script.message },
        },
      };
      return;
    }
    yield { type: 'text-delta', text: script.text };
    if (script.usage !== undefined) {
      yield { type: 'usage', usage: script.usage };
    }
    yield { type: 'finish', reason: { kind: 'stop' } };
  })();
}

/**
 * A chat backend that answers from a script.
 *
 * Each call consumes the next script; running past the end throws, so a test that
 * expected one attempt and got three fails loudly instead of quietly reusing an
 * answer.
 */
export function offlineChatBackend(options: OfflineChatOptions): ChatBackend {
  let index = 0;
  const stream = (
    _options: StreamOptionsLike,
  ): AsyncIterable<Record<string, unknown>> => {
    const script = options.scripts[index];
    index += 1;
    if (script === undefined) {
      throw new Error(
        `offline chat script exhausted after ${String(options.scripts.length)} attempt(s)`,
      );
    }
    return streamOf(script);
  };
  const llm: LlmLike = { stream };
  const transport: ChatTransportContext = {
    llm,
    chat: {
      provider: options.provider ?? 'offline',
      model: options.model ?? 'offline-model',
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 5_000,
      maxRepairRetries: Math.max(0, options.scripts.length - 1),
    },
    signal: new AbortController().signal,
  };
  return { kind: 'chat', transport };
}

/**
 * A decision backend that answers from a script.
 *
 * The stub records every request it received, in order, so a test can assert the
 * envelope it actually sent rather than the one it believes it sent.
 */
export interface OfflineDecisionOptions {
  readonly scripts: readonly OfflineDecisionScript[];
  readonly url?: string;
  readonly model?: string;
  /** A credential to send and therefore to redact, or none. */
  readonly credential?: string;
  readonly requests?: unknown[];
}

export function offlineDecisionBackend(
  options: OfflineDecisionOptions,
): DecisionBackend {
  let index = 0;
  const fetch = (
    _input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    if (init?.body !== undefined && options.requests !== undefined) {
      options.requests.push(
        typeof init.body === 'string' ? JSON.parse(init.body) : null,
      );
    }
    const script = options.scripts[index];
    index += 1;
    if (script === undefined) {
      return Promise.reject(
        new Error(
          `offline decision script exhausted after ${String(options.scripts.length)} attempt(s)`,
        ),
      );
    }
    return Promise.resolve(
      new Response(script.body, {
        status: script.status,
        headers: { 'content-type': 'application/json' },
      }),
    );
  };
  const transport: DecisionTransportContext = {
    fetch: (input, init) => fetch(input, init),
    credentials:
      options.credential === undefined
        ? undefined
        : {
            resolve: () => Promise.resolve({ value: options.credential ?? '' }),
          },
    decision: {
      url: options.url ?? 'https://offline.test/v1/systemone',
      model: options.model ?? 'offline-decision',
      apiKeyRef: options.credential === undefined ? '' : 'OFFLINE_KEY',
      timeoutMs: 5_000,
      costTier: 'free',
    },
    signal: new AbortController().signal,
  };
  return { kind: 'decision', transport };
}
