/**
 * The chat service a headless run reaches, when there is no host to borrow one from.
 *
 * Production's chat transport streams through `ctx.llm`, the host's own LLM service.
 * A `pnpm evals run` process has no host session, so every live chat cell used to be
 * refused before dispatch. This module supplies the missing half: an `LlmLike` backed by
 * one HTTP API, built from an environment variable rather than from a host.
 *
 * Three rules keep it honest:
 *
 *   - it is an adapter, not a second reviewer. It moves bytes and reports them in the
 *     chunk vocabulary production already reads (`text-delta`, `usage`, `finish`), so the
 *     prompt, the parser, the repair retry and the outcome mapping remain production's
 *     own code. Nothing here decides a score.
 *   - the credential is read at call time and never stored, logged or copied into a
 *     record. Only the provider's *name* for the variable appears in a plan.
 *   - a route it cannot serve is named, not attempted. A plan that asks for some other
 *     provider is refused before a cell is written, because "every cell failed with the
 *     same error" is a much worse way to learn that.
 *
 * The SSE vocabulary is DeepSeek's, which is the OpenAI chat-completions shape: one
 * `data:` line per event, `[DONE]` to terminate, `choices[0].delta.content` for text and
 * an optional terminal `usage` object.
 */

import { ChatStreamError } from '../../../src/reviewer/llm.js';
import type { LlmLike, StreamOptionsLike } from '../../../src/reviewer/llm.js';

/** One chat provider a headless run can reach, and where its credential comes from. */
export interface HeadlessChatRoute {
  /** The route id a plan names in its chat section's `provider`. */
  readonly provider: string;
  /** The environment variable the credential is read from at call time. */
  readonly credential: string;
}

/**
 * The routes this build's headless service serves.
 *
 * Deliberately an explicit list rather than a fallback: an unlisted provider is a plan
 * asking for something this runner cannot reach, and guessing an endpoint from a provider
 * id would send a review to a service the operator never named.
 */
export const HEADLESS_CHAT_ROUTES: readonly HeadlessChatRoute[] = [
  { provider: 'deepseek-account', credential: 'DEEPSEEK_API_KEY' },
];

/** The endpoint the DeepSeek route posts to. */
const DEEPSEEK_URL = 'https://api.deepseek.com/chat/completions';

/** The route a provider id names, or null when this build cannot serve it. */
export function routeOf(provider: string): HeadlessChatRoute | null {
  return (
    HEADLESS_CHAT_ROUTES.find((route) => route.provider === provider) ?? null
  );
}

/**
 * A chat service that can state which routes it serves and what each one needs.
 *
 * The preflight asks the service rather than a table of its own: a second copy of the
 * route list would pass a plan the transport then refuses, which is exactly the
 * "preflight said yes, every cell failed" failure the check exists to prevent.
 */
export interface RoutedChatService extends LlmLike {
  readonly routes: readonly HeadlessChatRoute[];
}

/** Whether a service states its routes, narrowing it without asserting. */
function isRouted(value: LlmLike): value is RoutedChatService {
  return Array.isArray(Reflect.get(value, 'routes'));
}

/**
 * Why a plan's chat providers cannot be dispatched through this service.
 *
 * A service that does not publish its routes is a composition this module cannot audit —
 * an in-process caller's own service — so nothing is reported for it: refusing a plan it
 * could serve would be worse than the risk of a late failure, and only the caller knows
 * what it wired. The headless service always publishes them, so the CLI path is checked.
 *
 * Reported before the run directory exists, because a live run that starts and then fails
 * every chat cell produces a directory full of identical failures that read like provider
 * outages rather than a configuration mistake.
 */
export function chatRouteProblems(
  llm: LlmLike,
  providers: readonly string[],
  env: (name: string) => string | undefined,
): readonly string[] {
  if (!isRouted(llm)) return [];
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const provider of providers) {
    if (seen.has(provider)) continue;
    seen.add(provider);
    const route = llm.routes.find((entry) => entry.provider === provider);
    if (route === undefined) {
      const known =
        llm.routes
          .map((entry) => `${entry.provider} (${entry.credential})`)
          .join(', ') || '(none)';
      problems.push(
        `chat provider "${provider}" has no headless route; this run can reach ${known}, and a plan must name one of them because a headless run has no host LLM service to borrow`,
      );
      continue;
    }
    if ((env(route.credential) ?? '').length === 0) {
      problems.push(
        `a live chat run needs ${route.credential} for provider "${provider}"; refusing to start without it`,
      );
    }
  }
  return problems;
}

/** A non-array object, for narrowing provider JSON without asserting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The text of one `delta.content`, or null when this event carried none. */
function deltaText(delta: unknown): string | null {
  if (!isRecord(delta)) return null;
  const content = delta['content'];
  return typeof content === 'string' && content.length > 0 ? content : null;
}

/**
 * The finish a provider's `finish_reason` names.
 *
 * `stop` is the only normal end. Every other reason is the provider saying it did not
 * finish the answer it was asked for, which `collectChatText` already knows how to report
 * as a provider refusal rather than as a parser problem — the distinction decides whether
 * a person is looking at a broken reviewer or a truncated one.
 */
function finishOf(reason: string): Record<string, unknown> {
  if (isNormalFinish(reason)) {
    return { type: 'finish', reason: { kind: 'stop' } };
  }
  return {
    type: 'finish',
    reason: {
      kind: 'error',
      failure: {
        code: reason,
        message:
          reason === 'length'
            ? 'the provider stopped at its output token limit'
            : `the provider ended the stream with ${reason}`,
      },
    },
  };
}

/**
 * Whether a finish reason ends the answer normally.
 *
 * Named once so "which reason may be deferred" and "which reason renders a stop" cannot
 * drift apart: a reason that counts as normal is emitted immediately and never held.
 */
function isNormalFinish(reason: string): boolean {
  return reason === 'stop' || reason === 'end_turn';
}

/**
 * The messages an OpenAI-compatible endpoint takes.
 *
 * Production hands the system prompt and the user turns over separately, and this is the
 * one place that shape becomes the wire's: the system prompt is the first message, and a
 * repair turn is already a second user message in production's own list. A block list is
 * joined because the wire has one text field per message and production only ever emits
 * text blocks.
 */
function messagesOf(
  options: StreamOptionsLike,
): readonly { readonly role: string; readonly content: string }[] {
  return [
    { role: 'system', content: options.system },
    ...options.messages.map((message) => ({
      role: message.role,
      content: message.content.map((part) => part.text).join(''),
    })),
  ];
}

/** The request body one call sends. */
function bodyOf(options: StreamOptionsLike): Record<string, unknown> {
  return {
    model: options.model,
    messages: messagesOf(options),
    stream: true,
    // Without this the provider reports no usage on a streamed call, and a run whose
    // whole point is to record what it spent would have nothing to record.
    stream_options: { include_usage: true },
    ...(options.temperature === undefined
      ? {}
      : { temperature: options.temperature }),
    ...(options.maxTokens === undefined
      ? {}
      : { max_tokens: options.maxTokens }),
  };
}

/**
 * Read one response body as the chunk vocabulary production consumes.
 *
 * A line the provider sends that is not an event is ignored rather than fatal: SSE allows
 * comments and keep-alives, and treating one as a broken answer would report a transport
 * fault that never happened. A malformed `data:` payload *is* fatal, because that is the
 * provider contradicting its own format.
 */
async function* events(
  body: ReadableStream<Uint8Array>,
  usage: () => unknown,
): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Whether a finish has been emitted. Tracked here rather than inside `handle` because a
  // closure that both mutates it and is called from the loop makes the loop's own reads
  // unprovable to the type checker, and the one thing this variable must guarantee is that
  // "no finish was emitted" cannot be read as a normal end.
  let finished = false;
  // The failure finish held back until the usage that prices it has been read.
  //
  // An OpenAI-compatible provider may send `finish_reason: "length"` and then report the
  // usage in a following usage-only chunk. Emitting the failure immediately makes
  // `collectChatText` throw, which ends this generator before that chunk is read — so the
  // provider's own token counts, the only record of what a truncated call cost, would be
  // lost. A failure finish is therefore held until either the usage arrives or the stream
  // ends, and only a *failure* finish is held: `stop` carries nothing a later chunk can
  // improve on.
  let heldFinish: string | null = null;
  /** The events one payload produces, and whether it ended the answer. */
  const handle = (
    payload: string,
  ): {
    readonly events: Record<string, unknown>[];
    readonly ended: boolean;
    /** A failure finish this payload wants reported after its usage is read. */
    readonly hold: string | null;
  } => {
    if (payload.length === 0) return { events: [], ended: false, hold: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(payload) as unknown;
    } catch {
      throw new ChatStreamError(
        'chat provider sent a stream event that is not valid JSON',
        usage(),
      );
    }
    if (!isRecord(parsed)) {
      throw new ChatStreamError(
        'chat provider sent a stream event that is not a JSON object',
        usage(),
      );
    }
    const out: Record<string, unknown>[] = [];
    // An error event is the provider refusing the call, even mid-stream.
    if (parsed['error'] !== undefined) {
      const error = parsed['error'];
      const code = isRecord(error) ? error['code'] : undefined;
      const message = isRecord(error) ? error['message'] : undefined;
      throw new ChatStreamError(
        `chat provider reported ${typeof code === 'string' ? code : 'an error'}: ${typeof message === 'string' ? message : ''}`,
        usage(),
        'provider-refusal',
      );
    }
    const carriedUsage = isRecord(parsed['usage']);
    if (carriedUsage) {
      out.push({ type: 'usage', usage: parsed['usage'] });
    }
    const choices = parsed['choices'];
    const choice =
      Array.isArray(choices) && isRecord(choices[0]) ? choices[0] : null;
    if (choice === null) return { events: out, ended: false, hold: null };
    const text = deltaText(choice['delta']);
    if (text !== null) out.push({ type: 'text-delta', text });
    const reason = choice['finish_reason'];
    if (typeof reason === 'string' && reason.length > 0) {
      // A normal stop is emitted here; a failure is deferred only when its own chunk
      // carried no usage, because then the numbers can still arrive in a later one.
      if (isNormalFinish(reason) || carriedUsage) {
        out.push(finishOf(reason));
        return { events: out, ended: true, hold: null };
      }
      return { events: out, ended: true, hold: reason };
    }
    return { events: out, ended: false, hold: null };
  };
  try {
    for (;;) {
      const read = await reader.read();
      if (read.done) break;
      buffer += decoder.decode(read.value, { stream: true });
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) break;
        const line = buffer.slice(0, newline).replace(/\r$/u, '');
        buffer = buffer.slice(newline + 1);
        if (line.length === 0 || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;
        const payload = line.slice('data:'.length).trim();
        if (payload === '[DONE]') {
          // The stream's own terminator. A provider that already sent a finish reason has
          // said why it ended; one that did not ended normally by this marker alone.
          if (heldFinish !== null) {
            yield finishOf(heldFinish);
            heldFinish = null;
            finished = true;
          }
          if (!finished) yield { type: 'finish', reason: { kind: 'stop' } };
          return;
        }
        const handled = handle(payload);
        // The pending finish was chosen by an *earlier* payload; this one is what prices
        // it, so it is reported before moving on. A payload that only creates the pending
        // finish must not release it: its usage can still be on the wire.
        const priced = handled.events.some(
          (event) => event['type'] === 'usage',
        );
        yield* handled.events;
        if (priced && heldFinish !== null) {
          yield finishOf(heldFinish);
          heldFinish = null;
          finished = true;
        }
        if (handled.hold !== null) heldFinish = handled.hold;
        if (handled.ended && heldFinish === null) finished = true;
      }
    }
    // A body that ended without `[DONE]` still produced whatever it produced; the last
    // flush exists so a multi-byte character split across the final read is not lost.
    const tail = `${buffer}${decoder.decode()}`.replace(/\r$/u, '');
    if (tail.startsWith('data:')) {
      const payload = tail.slice('data:'.length).trim();
      if (payload !== '[DONE]') {
        const handled = handle(payload);
        const priced = handled.events.some(
          (event) => event['type'] === 'usage',
        );
        yield* handled.events;
        if (priced && heldFinish !== null) {
          yield finishOf(heldFinish);
          heldFinish = null;
          finished = true;
        }
        if (handled.hold !== null) heldFinish = handled.hold;
        if (handled.ended && heldFinish === null) finished = true;
      }
    }
    if (heldFinish !== null) {
      // A failure finish whose usage never arrived is still the provider's own reason for
      // ending the answer, so it is reported rather than downgraded to "no finish".
      yield finishOf(heldFinish);
      heldFinish = null;
      finished = true;
    }
    if (!finished) {
      // No terminator and no finish reason: the stream simply stopped. Leaving it to the
      // caller would report a successful empty answer; one attempt that ended without
      // telling us why is a transport fault.
      throw new ChatStreamError(
        'chat provider closed the stream without a finish reason',
        usage(),
      );
    }
  } finally {
    // Releasing the reader is what lets the socket go when a cell was cancelled and the
    // consumer stopped iterating early.
    await reader.cancel().catch(() => undefined);
  }
}

/** What one headless chat service needs. */
export interface HeadlessChatOptions {
  /** Reads one environment variable, so a test never needs a real credential. */
  readonly read: (name: string) => string | undefined;
  /** The fetch to post with, injected so a test never reaches the network. */
  readonly fetch?: typeof fetch;
  /** The endpoint, for a caller that points at a compatible service. */
  readonly url?: string;
}

/**
 * The `LlmLike` a headless run streams chat cells through.
 *
 * One service serves every route the plan names, because a run has one `io.llm` and the
 * provider is passed per call: routing by the call rather than by the construction is what
 * lets a multi-provider plan use one runner. It publishes `routes` so the preflight checks
 * the same table the transport resolves through.
 */
export function headlessChatService(
  options: HeadlessChatOptions,
): RoutedChatService {
  const send = options.fetch ?? ((input, init) => fetch(input, init));
  return {
    routes: HEADLESS_CHAT_ROUTES,
    stream: (streamOptions) => {
      const route = routeOf(streamOptions.provider);
      if (route === null) {
        // Preflight refuses this, so reaching it means a caller skipped the preflight. The
        // error names the route rather than guessing an endpoint.
        throw new ChatStreamError(
          `chat provider "${streamOptions.provider}" has no headless route`,
          null,
        );
      }
      const credential = options.read(route.credential) ?? '';
      if (credential.length === 0) {
        throw new ChatStreamError(
          `${route.credential} is not set, so the ${route.provider} route cannot be called`,
          null,
        );
      }
      return streamOnce({
        send,
        url: options.url ?? DEEPSEEK_URL,
        credential,
        provider: streamOptions.provider,
        body: bodyOf(streamOptions),
        signal: streamOptions.signal,
      });
    },
  };
}

/**
 * One streamed call.
 *
 * The credential is used here and nowhere else: it is not attached to the error, not
 * reported as usage and not stored. A refusal's body is read for the provider's own
 * explanation, which is what tells an operator whether the key was rejected or the model
 * name was wrong.
 */
async function* streamOnce(parts: {
  readonly send: typeof fetch;
  readonly url: string;
  readonly credential: string;
  readonly provider: string;
  readonly body: Record<string, unknown>;
  readonly signal: AbortSignal | undefined;
}): AsyncGenerator<Record<string, unknown>> {
  const response = await parts.send(parts.url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'text/event-stream',
      authorization: `Bearer ${parts.credential}`,
    },
    body: JSON.stringify(parts.body),
    ...(parts.signal === undefined ? {} : { signal: parts.signal }),
  });
  if (!response.ok || response.body === null) {
    const text = await response.text().catch(() => '');
    throw new ChatStreamError(
      `chat provider ${parts.provider} refused the call with HTTP ${String(response.status)}${text.length === 0 ? '' : `: ${text.slice(0, 300)}`}`,
      null,
      'provider-refusal',
    );
  }
  let lastUsage: unknown = null;
  for await (const event of events(response.body, () => lastUsage)) {
    if (event['type'] === 'usage') lastUsage = event['usage'];
    yield event;
  }
}
