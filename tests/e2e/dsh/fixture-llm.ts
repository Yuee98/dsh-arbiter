/**
 * Deterministic model adapter for the isolated lifecycle suite.
 *
 * Agent turns replay one scripted `bash` call taken from the user's own text:
 * a message containing `RUN <shell command>` asks for exactly that call, and
 * the next request answers with plain text. The adapter never decides
 * anything, so a gate decision in the session log can only come from Arbiter.
 *
 * This is a fixture on the real `llm` service, not a product path. Reviewer
 * requests are answered with one fixed, low-risk, authorized verdict so a
 * review-path call settles deterministically; the suite also covers rule-only
 * decisions, which never reach the model.
 */

/** The fixed reviewer answer: low risk, clearly authorized, nothing alarming. */
const REVIEW_ANSWER = JSON.stringify({
  risk: 2,
  authorized: 8,
  secrets: false,
  destructive: false,
  egress: false,
  bulk: false,
});

export const name = 'arbiter-e2e-llm';
export const inject = ['llm'];

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
  readonly name?: string;
}

interface ChatMessage {
  readonly role?: string;
  readonly content?: unknown;
}

export interface FixtureConfig {
  readonly provider?: string;
}

function textOfBlocks(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return (content as readonly ContentBlock[])
    .filter((block) => block.type === 'text')
    .map((block) => block.text ?? '')
    .join('\n');
}

interface RequestedTurn {
  readonly text: string;
  /** The `RUN <command>` marker of this turn, when present. */
  readonly command: string | null;
  /** The `DELEGATE <task>` marker of this turn, when present. */
  readonly delegate: string | null;
}

function markerValue(text: string, marker: string): string | null {
  const at = text.lastIndexOf(marker);
  if (at === -1) return null;
  const rest = text.slice(at + marker.length);
  const line = rest.split(/\r?\n/u)[0] ?? '';
  return line.trim().length > 0 ? line.trim() : null;
}

function requestedTurn(messages: readonly ChatMessage[]): RequestedTurn {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message === undefined || message.role !== 'user') continue;
    const text = textOfBlocks(message.content);
    const command = markerValue(text, 'RUN ');
    const delegate = markerValue(text, 'DELEGATE ');
    if (command === null && delegate === null) continue;
    return { text, command, delegate };
  }
  return { text: '', command: null, delegate: null };
}

/** Whether the user turn carrying `text` already produced a tool call. */
function alreadyCalled(
  messages: readonly ChatMessage[],
  text: string,
): boolean {
  let started = false;
  for (const message of messages) {
    if (
      message.role === 'user' &&
      textOfBlocks(message.content).includes(text)
    ) {
      started = true;
      continue;
    }
    if (!started) continue;
    if (message.role === 'tool') return true;
    if (message.role === 'assistant' && Array.isArray(message.content)) {
      const blocks = message.content as readonly ContentBlock[];
      if (blocks.some((block) => block.type === 'tool-call')) return true;
    }
  }
  return false;
}

interface StreamChunk {
  readonly type: string;
  readonly [key: string]: unknown;
}

class FixtureAdapter {
  providerInfo(provider: string): Record<string, unknown> {
    return { id: provider, name: 'Arbiter E2E Fixture' };
  }
  providerRetryPolicy(): undefined {
    return undefined;
  }
  async prepareCall(provider: string, model: string) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (options: { readonly messages?: readonly ChatMessage[] }) =>
        this.stream(options),
    };
  }
  listModels(provider: string): Promise<readonly Record<string, unknown>[]> {
    return Promise.resolve([
      { provider, id: 'arbiter-fixture', name: 'arbiter-fixture' },
    ]);
  }
  resolveModel(
    provider: string,
    model: string,
  ): Promise<Record<string, unknown>> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200_000 },
      defaultMaxTokens: 8_192,
    });
  }

  /** One deterministic answer, yielded through a real async generator. */
  async *stream(options: {
    readonly system?: string;
    readonly messages?: readonly ChatMessage[];
  }): AsyncGenerator<StreamChunk> {
    // Yield to the event loop once: a consumer driving the stream in the same
    // tick must not observe a fully synchronous answer.
    await Promise.resolve();
    const system = options.system ?? '';
    if (system.startsWith('REVIEW_POLICY')) {
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: REVIEW_ANSWER };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: REVIEW_ANSWER },
      };
      yield {
        type: 'usage',
        usage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 },
      };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }
    const messages = options.messages ?? [];
    const { text, command, delegate } = requestedTurn(messages);
    if (delegate !== null && !alreadyCalled(messages, text)) {
      // A real delegation: the child is a host-managed subagent session whose
      // own turns run the same fixture.
      const id = `fx-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}`;
      const args = JSON.stringify({
        description: 'fixture delegation',
        prompt: `Delegated task. RUN ${delegate}`,
      });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Delegating.' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Delegating.' },
      };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 1,
        id,
        name: 'subagent',
        argumentsDelta: args,
      };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id, name: 'subagent', arguments: args },
      };
    } else if (command !== null && !alreadyCalled(messages, text)) {
      const id = `fx-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}`;
      const args = JSON.stringify({ command, description: 'fixture call' });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield {
        type: 'text-delta',
        index: 0,
        text: 'Running the requested call.',
      };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Running the requested call.' },
      };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 1,
        id,
        name: 'bash',
        argumentsDelta: args,
      };
      yield {
        type: 'block-end',
        index: 1,
        block: { type: 'tool-call', id, name: 'bash', arguments: args },
      };
    } else {
      const reply = 'FIXTURE-DONE';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: reply };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: reply },
      };
    }
    yield {
      type: 'usage',
      usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 },
    };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

interface LlmService {
  registerAdapter(providers: readonly string[], adapter: unknown): unknown;
}

export function apply(
  ctx: { readonly llm: LlmService },
  config: FixtureConfig,
): void {
  ctx.llm.registerAdapter(
    [config.provider ?? 'arbiter-fixture'],
    new FixtureAdapter(),
  );
}
