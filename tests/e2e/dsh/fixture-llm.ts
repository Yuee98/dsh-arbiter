import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

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
  authorization: 8,
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
  /**
   * Directory for the review barrier. A reviewer request whose pending action
   * text contains `holdMatch` is reported as `<dir>/<callId>-started.json` and
   * held until `<dir>/<callId>-release` exists, so a driver can act while the
   * review really is in flight instead of guessing from timing.
   */
  readonly barrierDir?: string;
  readonly holdMatch?: string;
  readonly barrierTimeoutMs?: number;
  /**
   * Directory receiving one JSON file per conversation model request.
   *
   * The file records the exact system prompt and user-role context the host
   * actually sent, which is the only honest evidence of what the model saw on
   * one step. A session log keeps historical messages even after a compaction
   * replaced them, so reading the log alone cannot distinguish the effective
   * prompt from an older one.
   */
  readonly requestDir?: string;
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
  /**
   * Commands of one step that issues several independent calls.
   *
   * A `RUN2 <command>` line adds a second `bash` call to the same assistant
   * message, so a case can observe two calls whose outcomes differ inside one
   * step instead of racing two separate turns.
   */
  readonly commands: readonly string[];
  /** The `DELEGATE <task>` marker of this turn, when present. */
  readonly delegate: string | null;
  /** The `ASK <question>` marker of this turn, when present. */
  readonly ask: string | null;
}

function markerValue(
  text: string,
  marker: string,
  at = text.lastIndexOf(marker),
): string | null {
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
    const second = markerValue(text, 'RUN2 ');
    const delegate = markerValue(text, 'DELEGATE ');
    const ask = markerValue(text, 'ASK ');
    if (command === null && delegate === null && ask === null) continue;
    return {
      text,
      command,
      commands: [
        ...(command === null ? [] : [command]),
        ...(second === null ? [] : [second]),
      ],
      delegate,
      ask,
    };
  }
  return { text: '', command: null, commands: [], delegate: null, ask: null };
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
  private readonly config: FixtureConfig;
  private reviewIndex = 0;
  /** Monotone index of recorded conversation requests. */
  private requestIndex = 0;

  constructor(config: FixtureConfig) {
    this.config = config;
  }

  /**
   * Hold one review open so a driver can act while it is genuinely in flight.
   *
   * The `callId` comes from the plugin's own `ARBITER_TRACE_PATH` trace, which
   * records `review/start` with the real call id just before asking the model.
   * The fixture never decides anything: it reports that a review started and
   * waits for the driver's release file.
   */
  private async barrier(messages: readonly ChatMessage[]): Promise<void> {
    const directory = this.config.barrierDir;
    if (directory === undefined) return;
    const hold = this.config.holdMatch;
    const text = pendingActionText(messages);
    if (hold === undefined || !text.includes(hold)) return;
    const tracePath = process.env['ARBITER_TRACE_PATH'] ?? '';
    const callId =
      lastReviewCallId(tracePath) ?? `review-${String(Date.now())}`;
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${callId}-started.json`),
      JSON.stringify({ callId, at: Date.now(), pending: text.slice(0, 200) }),
    );
    const release = join(directory, `${callId}-release`);
    const deadline = Date.now() + (this.config.barrierTimeoutMs ?? 120_000);
    while (!existsSync(release) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    this.reviewIndex += 1;
  }

  providerInfo(provider: string): Record<string, unknown> {
    return { id: provider, name: 'Arbiter E2E Fixture' };
  }
  providerRetryPolicy(): undefined {
    return undefined;
  }
  /**
   * The base adapter contract declares no request-image pricing.
   *
   * This fixture is a plain object on the real `llm` service rather than an
   * `LlmAdapter` subclass, so it states the same default explicitly: the token
   * meter calls this hook when it prices a compaction request.
   */
  imageRequestPricing(): undefined {
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

  /**
   * Write the exact request the host sent for one conversation step.
   *
   * Only conversation requests are recorded: a reviewer or compaction call is
   * a different purpose and must not be mistaken for the agent's own view.
   */
  private recordRequest(options: {
    readonly system?: string;
    readonly messages?: readonly ChatMessage[];
  }): void {
    const directory = this.config.requestDir;
    if (directory === undefined) return;
    mkdirSync(directory, { recursive: true });
    const messages = options.messages ?? [];
    const text = messages.map((message) => textOfBlocks(message.content));
    // A loop-built request carries the system prompt as the leading system-role
    // message in `messages`; `options.system` is only set by a one-shot caller.
    // Record whichever form this request actually used, so a driver reads the
    // prompt the model really received.
    const fromMessages = messages
      .filter((message) => message.role === 'system')
      .map((message) => textOfBlocks(message.content))
      .join('\n\n');
    // One file per request, ordered by name so a driver reads them in order.
    const index = this.requestIndex;
    this.requestIndex += 1;
    writeFileSync(
      join(directory, `${String(index).padStart(4, '0')}.json`),
      JSON.stringify({
        at: Date.now(),
        system:
          options.system ?? (fromMessages.length > 0 ? fromMessages : null),
        userTexts: text,
      }),
    );
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
    // The contract both protocols start with. Checking the current prefix is what
    // keeps this fixture recognizing a review after the shared-contract switch: a
    // fixture keyed on the retired policy prefix would answer every review request
    // as an ordinary conversation turn.
    if (system.startsWith('REVIEW_CONTRACT')) {
      await this.barrier(options.messages ?? []);
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
    this.recordRequest(options);
    const messages = options.messages ?? [];
    const { text, command, commands, delegate, ask } = requestedTurn(messages);
    // A turn that already produced its calls falls through to the plain reply,
    // so every command is issued exactly once.
    const issuing = alreadyCalled(messages, text) ? [] : commands;
    if (issuing.length > 1) {
      // Several independent calls in one assistant step: the host schedules
      // them by its own concurrency rule, so a case can observe one refusal and
      // one successful execution without racing two turns.
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield {
        type: 'text-delta',
        index: 0,
        text: 'Running the requested calls.',
      };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Running the requested calls.' },
      };
      for (const [offset, entry] of issuing.entries()) {
        const id = `fx-${String(Date.now())}-${String(offset)}-${String(Math.trunc(Math.random() * 1e6))}`;
        const args = JSON.stringify({
          command: entry,
          description: 'fixture call',
        });
        const index = offset + 1;
        yield { type: 'block-start', index, blockType: 'tool-call' };
        yield {
          type: 'tool-call-delta',
          index,
          id,
          name: 'bash',
          argumentsDelta: args,
        };
        yield {
          type: 'block-end',
          index,
          block: { type: 'tool-call', id, name: 'bash', arguments: args },
        };
      }
    } else if (ask !== null && !alreadyCalled(messages, text)) {
      // A real `ask_user_question` call: the answer card, the answerer
      // waterfall and the recorded reply are all the host's own path.
      const id = `fx-${String(Date.now())}-${String(Math.trunc(Math.random() * 1e6))}`;
      const args = JSON.stringify({
        questions: [
          {
            id: 'authorization',
            question: ask,
            options: [{ label: '允许' }, { label: '不允许' }],
          },
        ],
      });
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: 'Asking the user.' };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: 'Asking the user.' },
      };
      yield { type: 'block-start', index: 1, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index: 1,
        id,
        name: 'ask_user_question',
        argumentsDelta: args,
      };
      yield {
        type: 'block-end',
        index: 1,
        block: {
          type: 'tool-call',
          id,
          name: 'ask_user_question',
          arguments: args,
        },
      };
    } else if (delegate !== null && !alreadyCalled(messages, text)) {
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

/** The newest `review/start` call id the plugin recorded, if any. */
function lastReviewCallId(tracePath: string): string | null {
  if (tracePath.length === 0) return null;
  try {
    const lines = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      const line = lines[index];
      if (line === undefined) continue;
      const entry: unknown = JSON.parse(line);
      if (entry === null || typeof entry !== 'object') continue;
      if (Reflect.get(entry, 'event') !== 'review/start') continue;
      const callId: unknown = Reflect.get(entry, 'callId');
      if (typeof callId === 'string') return callId;
    }
  } catch {
    // An unreadable trace only means no barrier key; the review proceeds.
  }
  return null;
}

/** The pending action's own JSON block from the review request text. */
function pendingActionText(messages: readonly ChatMessage[]): string {
  const text = messages
    .map((message) => textOfBlocks(message.content))
    .join('\n');
  const at = text.lastIndexOf('PENDING_ACTION');
  if (at === -1) return '';
  const rest = text.slice(at + 'PENDING_ACTION'.length);
  // The blocks that can follow the action in the current material renderer.
  // Naming them exactly keeps the barrier key scoped to the pending action's own
  // JSON instead of swallowing the completeness report after it.
  const end = rest.search(
    /\n(?:ACTION_FACTS|REVIEW_HINT|MATERIAL_COMPLETENESS)\b/u,
  );
  return end === -1 ? rest : rest.slice(0, end);
}

export function apply(
  ctx: { readonly llm: LlmService },
  config: FixtureConfig,
): void {
  ctx.llm.registerAdapter(
    [config.provider ?? 'arbiter-fixture'],
    new FixtureAdapter(config),
  );
}
