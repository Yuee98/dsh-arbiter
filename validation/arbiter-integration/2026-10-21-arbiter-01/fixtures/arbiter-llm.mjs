/**
 * Deterministic LLM adapter for dsh-arbiter integration cases.
 *
 * Agent requests replay a scripted tool-call sequence. Reviewer requests are
 * recognized by the arbiter system prompt and answered from `reviewer` or
 * `reviewerDefault`. This is a TEST fixture: it makes no model decision.
 */
const name = 'arbiter-llm-fixture';
const inject = ['llm'];

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((block) => block && block.type === 'text')
    .map((block) => block.text)
    .join('\n');
}

function allUserText(messages) {
  return (messages ?? [])
    .filter((message) => message.role === 'user')
    .map((message) => textOfBlocks(message.content))
    .join('\n');
}

function stepIndex(messages, match) {
  let anchor = -1;
  const list = messages ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (message.role !== 'user') continue;
    if (typeof match !== 'string' || textOfBlocks(message.content).includes(match)) {
      anchor = index;
      break;
    }
  }
  let n = 0;
  for (let index = anchor + 1; index < list.length; index += 1) {
    if (list[index].role === 'assistant') n += 1;
  }
  return n;
}

function selectRoute(scenario, messages) {
  const text = allUserText(messages);
  for (const route of scenario.routes ?? []) {
    if (typeof route.match === 'string' && text.includes(route.match)) return route;
  }
  return { steps: scenario.default ?? [] };
}

class FixtureAdapter {
  constructor(scenarioPath) {
    this.scenarioPath = scenarioPath;
    this.sequence = 0;
  }

  providerInfo(provider) {
    return { id: provider, name: 'Arbiter Integration Fixture' };
  }

  providerRetryPolicy() {
    return undefined;
  }

  imageRequestPricing() {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  async prepareCall(provider, model) {
    return { model: await this.resolveModel(provider, model), stream: (options) => this.stream(options) };
  }

  async listModels(provider) {
    return [{ provider, id: 'fixture-1', name: 'fixture-1' }];
  }

  async resolveModel(provider, model) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200000 },
      defaultMaxTokens: 8192,
    };
  }

  async *stream(options) {
    const { readFileSync, appendFileSync } = await import('node:fs');
    const scenario = JSON.parse(readFileSync(this.scenarioPath, 'utf8'));
    const system = typeof options.system === 'string' ? options.system : '';
    const sessionId = options.sessionId ?? 'unknown';

    if (system.startsWith('REVIEW_POLICY')) {
      const index = this.reviewerIndex ?? 0;
      this.reviewerIndex = index + 1;
      const reply = scenario.reviewer?.[index] ?? scenario.reviewerDefault ?? {
        risk: 2,
        authorized: 6,
        secrets: false,
        destructive: false,
        egress: false,
        bulk: false,
      };
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      try {
        appendFileSync(
          this.scenarioPath.replace(/scenario\.json$/u, 'reviewer-requests.jsonl'),
          JSON.stringify({
            at: new Date().toISOString(),
            index,
            systemHead: system.slice(0, 80),
            userText: textOfBlocks(options.messages?.[0]?.content).slice(0, 500),
            reply: text,
          }) + String.fromCharCode(10),
        );
      } catch {}
      yield { type: 'block-start', index: 0, blockType: 'text' };
      yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
      yield { type: 'usage', usage: { inputTokens: 900, outputTokens: 20, totalTokens: 920 } };
      yield { type: 'finish', reason: { kind: 'stop' } };
      return;
    }

    const route = selectRoute(scenario, options.messages);
    const index = stepIndex(options.messages, route.match);
    const step = (route.steps ?? [])[index] ?? { type: 'text', text: '[fixture] out of scripted steps' };
    try {
      appendFileSync(
        this.scenarioPath.replace(/scenario\.json$/u, 'agent-requests.jsonl'),
        JSON.stringify({
          at: new Date().toISOString(),
          route: route.match ?? 'default',
          index,
          sessionId,
        }) + String.fromCharCode(10),
      );
    } catch {}

    if (step.type === 'text' || step.text !== undefined) {
      const text = step.text ?? '';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      if (text.length > 0) yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    }
    if (step.type === 'calls') {
      let blockIndex = step.text !== undefined ? 1 : 0;
      for (const call of step.calls ?? []) {
        const id = `fixture-${sessionId}-${index}-${this.sequence++}`;
        const args = JSON.stringify(call.arguments ?? {});
        yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: args };
        yield {
          type: 'block-end',
          index: blockIndex,
          block: { type: 'tool-call', id, name: call.name, arguments: args },
        };
        blockIndex += 1;
      }
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx, config) {
  const provider = config.provider ?? 'arbiter-fixture';
  ctx.llm.registerAdapter([provider], new FixtureAdapter(config.scenarioPath));
}

export { name, inject };
