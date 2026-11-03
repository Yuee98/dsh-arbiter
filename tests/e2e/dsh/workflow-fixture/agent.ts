import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  authorized,
  probe,
  record,
  result,
  resultValue,
  text,
  type Call,
  type Config,
  type Message,
} from './protocol.ts';

interface Request {
  readonly messages?: readonly Message[];
  readonly purpose?: string;
}

function question(): Call {
  return {
    stage: 'question',
    name: 'ask_user_question',
    arguments: {
      questions: [
        {
          id: 'sample-only',
          question:
            '仅允许将 sample.txt 复制到 sample-delivery.txt，full.txt 不在许可内？',
          options: [{ label: '允许 sample 文件' }, { label: '不允许' }],
        },
      ],
    },
  };
}
function copy(config: Config, stage: string, full = false): Call {
  const workspace = readFileSync(
    join(config.directory, 'workspace.txt'),
    'utf8',
  );
  const source = full ? 'full.txt' : 'sample.txt';
  const target = full ? 'full-delivery.txt' : 'sample-delivery.txt';
  return {
    stage,
    name: 'bash',
    arguments: {
      command: `cp '${join(workspace, source)}' '${join(workspace, target)}'`,
      description: '受控交付',
    },
  };
}
function askTrajectory(config: Config, messages: readonly Message[]): Call[] {
  const first = result(messages, 'P1');
  if (first === undefined) return [copy(config, 'P1')];
  if (first.isError !== true)
    throw new Error('P1 must be denied before asking');
  const answer = result(messages, 'question');
  if (answer === undefined) return [question()];
  if (!authorized(resultValue(answer))) return [];
  const copied = result(messages, 'P2');
  if (copied === undefined) return [copy(config, 'P2')];
  if (copied.isError === true) throw new Error('authorized P2 did not execute');
  return result(messages, 'P3') === undefined ? [copy(config, 'P3', true)] : [];
}
function timedTrajectory(messages: readonly Message[]): Call[] {
  const answer = result(messages, 'question');
  if (answer === undefined) return [question()];
  const pending = resultValue(answer);
  if (pending['pending'] !== true)
    throw new Error('timed fixture requires pending');
  const late = messages.findLast((message) => {
    if (message.role !== 'user') return false;
    const value = resultValue(message);
    return (
      value['kind'] === 'answer_to_pending_question' &&
      value['callId'] === answer.toolCallId &&
      authorized(value)
    );
  });
  if (late !== undefined)
    return result(messages, 'late-authorized') === undefined
      ? [probe('late-authorized')]
      : [];
  return result(messages, 'pending-independent') === undefined
    ? [probe('pending-independent')]
    : [];
}

class WorkflowAgent {
  private index = 0;
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  providerInfo(provider: string) {
    return { id: provider, name: 'Workflow Agent Fixture' };
  }
  providerRetryPolicy(): undefined {
    return undefined;
  }
  imageRequestPricing(): undefined {
    return undefined;
  }
  listModels(provider: string) {
    return Promise.resolve([{ provider, id: 'workflow', name: 'workflow' }]);
  }
  resolveModel(provider: string, model: string) {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200000 },
      defaultMaxTokens: 8192,
    });
  }
  async prepareCall(provider: string, model: string) {
    return {
      model: await this.resolveModel(provider, model),
      stream: (request: Request) => this.stream(request),
    };
  }
  private async calls(messages: readonly Message[]): Promise<Call[]> {
    const userText = messages
      .filter((message) => message.role === 'user')
      .map((message) => text(message.content))
      .join('\n');
    if (!userText.includes('CW126-START') && !userText.includes('CW126-CHILD'))
      return [];
    if (this.config.scenario === 'ask')
      return askTrajectory(this.config, messages);
    if (this.config.scenario === 'timed') return timedTrajectory(messages);
    if (this.config.scenario === 'approval') {
      const c = result(messages, 'C');
      if (c === undefined) return [probe('C')];
      return c.isError === true || result(messages, 'D') !== undefined
        ? []
        : [probe('D')];
    }
    if (this.config.scenario === 'continuity') {
      if (
        result(messages, 'slow') === undefined ||
        result(messages, 'before') === undefined
      )
        return [probe('slow'), probe('before')];
      if (result(messages, 'after') === undefined) return [probe('after')];
      if (result(messages, 'failure') === undefined) return [probe('failure')];
      if (result(messages, 'failure')?.isError !== true)
        throw new Error('expected actual failure');
      return result(messages, 'repair') === undefined ? [probe('repair')] : [];
    }
    if (!userText.includes('CW126-CHILD')) {
      return result(messages, 'delegate') === undefined
        ? [
            {
              stage: 'delegate',
              name: 'subagent',
              arguments: {
                description: '受控子任务',
                prompt: 'CW126-CHILD：遵守父会话限制，依次检查文件范围。',
              },
            },
          ]
        : [];
    }
    const stage =
      result(messages, 'child-1') === undefined
        ? 'child-1'
        : result(messages, 'child-2') === undefined
          ? 'child-2'
          : result(messages, 'child-3') === undefined
            ? 'child-3'
            : null;
    if (stage === null) return [];
    if (stage !== 'child-1') {
      mkdirSync(this.config.directory, { recursive: true });
      writeFileSync(join(this.config.directory, `${stage}-waiting`), 'waiting');
      const deadline = Date.now() + 120000;
      while (!existsSync(join(this.config.directory, `${stage}-release`))) {
        if (Date.now() >= deadline) throw new Error(`unreleased ${stage}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
    return [probe(stage)];
  }
  async *stream(request: Request) {
    const messages = request.messages ?? [];
    const directory = join(this.config.directory, 'agent');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(directory, `${String(this.index++).padStart(4, '0')}.json`),
      JSON.stringify(request),
    );
    const title = request.purpose === 'session-title';
    const calls = title ? [] : await this.calls(messages);
    for (const [index, call] of calls.entries()) {
      const id = `cw126-${call.stage}-${randomUUID()}`;
      const args = JSON.stringify(call.arguments);
      yield { type: 'block-start', index, blockType: 'tool-call' };
      yield {
        type: 'tool-call-delta',
        index,
        id,
        name: call.name,
        argumentsDelta: args,
      };
      yield {
        type: 'block-end',
        index,
        block: { type: 'tool-call', id, name: call.name, arguments: args },
      };
    }
    if (calls.length === 0) {
      const user = messages
        .filter((message) => message.role === 'user')
        .map((message) => text(message.content))
        .join(' ');
      const reply = title
        ? user.includes('CW126-SIBLING')
          ? 'CW126-SIBLING'
          : user.includes('CW126-CHILD')
            ? 'CW126-CHILD'
            : 'CW126-WARM'
        : 'CW126 fixture settled.';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text: reply };
      yield {
        type: 'block-end',
        index: 0,
        block: { type: 'text', text: reply },
      };
    }
    yield {
      type: 'finish',
      reason: { kind: calls.length === 0 ? 'stop' : 'tool-calls' },
    };
  }
}
export function apply(
  ctx: {
    readonly llm: {
      registerAdapter(providers: readonly string[], adapter: unknown): unknown;
    };
  },
  config: Config,
): void {
  // Keep the exact native request and result binding; no synthetic user events.
  if (record(config)['scenario'] === undefined)
    throw new Error('scenario required');
  ctx.llm.registerAdapter(
    ['arbiter-workflow-agent'],
    new WorkflowAgent(config),
  );
}
