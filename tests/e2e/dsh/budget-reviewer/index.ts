import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/** Task-owned reviewer route: capture actual wire material, answer offline. */
export const name = 'arbiter-budget-reviewer';
export const inject = ['llm'];

interface Request {
  readonly system?: string;
  readonly messages?: readonly {
    readonly role: string;
    readonly content: readonly {
      readonly type: string;
      readonly text: string;
    }[];
  }[];
}

class BudgetReviewer {
  private readonly directory: string;

  constructor(directory: string) {
    this.directory = directory;
  }

  providerInfo(provider: string) {
    return { id: provider, name: 'Budget Reviewer Fixture' };
  }
  providerRetryPolicy(): undefined {
    return undefined;
  }
  imageRequestPricing(): undefined {
    return undefined;
  }
  listModels(provider: string) {
    return Promise.resolve([
      { provider, id: 'budget-reviewer', name: 'budget-reviewer' },
    ]);
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
      throw new Error('budget route received a non-review request');
    mkdirSync(this.directory, { recursive: true });
    writeFileSync(
      join(
        this.directory,
        `${String(Date.now())}-${String(Math.random())}.json`,
      ),
      JSON.stringify(request),
    );
    const text = JSON.stringify({ risk: 2, authorization: 8 });
    yield { type: 'block-start', index: 0, blockType: 'text' };
    yield { type: 'text-delta', index: 0, text };
    yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(
  ctx: {
    readonly llm: {
      registerAdapter(providers: readonly string[], adapter: unknown): unknown;
    };
  },
  config: { readonly directory: string },
): void {
  ctx.llm.registerAdapter(
    ['arbiter-budget-reviewer'],
    new BudgetReviewer(config.directory),
  );
}
