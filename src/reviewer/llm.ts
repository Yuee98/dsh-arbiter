/**
 * The host's chat-completion service, as a reviewer needs it.
 *
 * The types live here rather than in the chat adapter so both the legacy adapter
 * and the reviewer service describe the same host surface: a second, drifting
 * copy of `LlmLike` would let one path see options the other cannot send.
 *
 * Nothing here decides anything. Route resolution and stream collection are
 * mechanics — the protocol, the parser and the outcome live elsewhere.
 */

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

export interface SessionLike {
  requestHeader?():
    | {
        readonly config: { readonly provider: string; readonly model: string };
      }
    | undefined;
}

export interface ChatRoute {
  readonly provider: string;
  readonly model: string;
}

/**
 * The provider/model this request goes to.
 *
 * `provider: "session"` follows whichever route the host says the session uses;
 * a session that names no complete route is an error rather than a silent
 * fallback, because falling back would send a review to a model the operator
 * did not choose.
 */
export function chatRoute(
  chat: { readonly provider: string; readonly model: string },
  session: SessionLike | undefined,
): ChatRoute {
  if (chat.provider === 'session') {
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
  if (chat.provider.length === 0 || chat.model.length === 0) {
    throw new Error('chat reviewer requires provider and model');
  }
  return { provider: chat.provider, model: chat.model };
}

export interface CollectedChat {
  readonly text: string;
  /** The provider's own usage payload, unmodified and not yet normalized. */
  readonly usage: unknown;
}

/**
 * A stream that failed after the provider had already reported usage.
 *
 * A provider that reports tokens and then fails its own call was still billed for
 * them, and that is exactly the attempt an operator most needs to see. Carrying
 * the payload on the error is what keeps it: throwing a plain string would lose the
 * only record of what the failure cost.
 */
export class ChatStreamError extends Error {
  readonly usage: unknown;

  constructor(message: string, usage: unknown) {
    super(message);
    this.name = 'ChatStreamError';
    this.usage = usage;
  }
}

/**
 * Read one chat stream to its end.
 *
 * A stream that ends without a terminal finish never completed, and a call with
 * no text produced no answer: both are transport failures rather than an empty
 * result, because an empty string would parse as "no answer" and be reported as
 * a format problem the model did not make.
 */
export async function collectChatText(
  stream: AsyncIterable<Record<string, unknown>>,
): Promise<CollectedChat> {
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
      if (!isStop(chunk['reason'])) throw failureOf(chunk['reason'], usage);
      finished = true;
    }
  }
  if (!finished) {
    throw new ChatStreamError('reviewer emitted no terminal finish', usage);
  }
  if (text.trim().length === 0) {
    throw new ChatStreamError('reviewer returned no text', usage);
  }
  return { text, usage };
}

function field(value: unknown, key: string): unknown {
  return value !== null && typeof value === 'object'
    ? Reflect.get(value, key)
    : null;
}

/**
 * Whether a finish reason is a normal stop.
 *
 * A provider that ends its stream with a failure reason is reporting its own
 * outcome, and treating that as a successful empty answer would turn a provider
 * fault into a parser fault.
 */
function isStop(reason: unknown): boolean {
  if (reason === null || typeof reason !== 'object') return true;
  return field(reason, 'kind') === 'stop';
}

/**
 * The error a failed finish reason names.
 *
 * The code and message are included because the connection test classifies the
 * stage from them; the usage is carried along so a billed failure is still
 * recorded.
 */
function failureOf(reason: unknown, usage: unknown): ChatStreamError {
  const failure = field(reason, 'failure');
  const code = field(failure, 'code');
  const message = field(failure, 'message');
  return new ChatStreamError(
    `reviewer ended with ${String(field(reason, 'kind'))} ${typeof code === 'string' ? code : ''}: ${typeof message === 'string' ? message : ''}`,
    usage,
  );
}
