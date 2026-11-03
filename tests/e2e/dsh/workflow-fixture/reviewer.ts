import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { record, type Message } from './protocol.ts';

interface Config {
  readonly directory: string;
  readonly tracePath: string;
  readonly scores: Readonly<Record<string, readonly [number, number]>>;
}
interface Request {
  readonly system?: string;
  readonly messages?: readonly Message[];
}
class WorkflowReviewer {
  private index = 0;
  private readonly config: Config;
  constructor(config: Config) {
    this.config = config;
  }
  providerInfo(provider: string) {
    return { id: provider, name: 'Workflow Reviewer Fixture' };
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
  async *stream(request: Request) {
    await Promise.resolve();
    if (!request.system?.startsWith('REVIEW_CONTRACT'))
      throw new Error('review route received agent traffic');
    const started = readFileSync(this.config.tracePath, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((line) => record(JSON.parse(line)))
      .findLast((entry) => entry['event'] === 'review/start');
    const callId = started?.['callId'];
    if (typeof callId !== 'string')
      throw new Error('no native review identity');
    const stage = Object.keys(this.config.scores).find((key) =>
      callId.startsWith(`cw126-${key}-`),
    );
    if (stage === undefined)
      throw new Error(`no predeclared answer for ${callId}`);
    const score = this.config.scores[stage];
    if (score === undefined) throw new Error('score missing');
    const answer = { risk: score[0], authorization: score[1] };
    const directory = join(this.config.directory, 'reviewer');
    mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(
        directory,
        `${String(this.index++).padStart(4, '0')}-${callId}.json`,
      ),
      JSON.stringify({ callId, stage, at: Date.now(), request, answer }),
    );
    const reply = JSON.stringify(answer);
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text: reply };
    yield { type: 'block-end', index: 0, block: { type: 'text', text: reply } };
    yield { type: 'finish', reason: { kind: 'stop' } };
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
  ctx.llm.registerAdapter(
    ['arbiter-workflow-reviewer'],
    new WorkflowReviewer(config),
  );
}
