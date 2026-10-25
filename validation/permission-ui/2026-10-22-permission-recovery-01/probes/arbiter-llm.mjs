/**
 * Deterministic LLM adapter for this run.
 *
 * Agent turns replay a scripted tool-call sequence. Reviewer requests are
 * recognised by the arbiter review system prompt and answered from the
 * scenario's `reviewer` list. This is a FIXTURE: it makes no model decision.
 */
const name = 'recovery-llm';
const inject = ['llm'];

function textOfBlocks(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.filter((b) => b && b.type === 'text').map((b) => b.text).join('\n');
}
function allUserText(messages) {
  return (messages ?? []).filter((m) => m.role === 'user').map((m) => textOfBlocks(m.content)).join('\n');
}
function stepIndex(messages, match) {
  const list = messages ?? [];
  let anchor = -1;
  for (let i = 0; i < list.length; i += 1) {
    const m = list[i];
    if (m.role !== 'user') continue;
    if (typeof match !== 'string' || textOfBlocks(m.content).includes(match)) { anchor = i; break; }
  }
  let n = 0;
  for (let i = anchor + 1; i < list.length; i += 1) if (list[i].role === 'assistant') n += 1;
  return n;
}
function selectRoute(scenario, messages) {
  const users = (messages ?? []).filter((m) => m.role === 'user');
  for (let i = users.length - 1; i >= 0; i -= 1) {
    const text = textOfBlocks(users[i].content);
    for (const route of scenario.routes ?? []) {
      if (typeof route.match === 'string' && text.includes(route.match)) return route;
    }
  }
  return { steps: scenario.default ?? [] };
}

class FixtureAdapter {
  constructor(scenarioPath) { this.scenarioPath = scenarioPath; this.sequence = 0; this.reviewerIndex = 0; }
  providerInfo(provider) { return { id: provider, name: 'Recovery Fixture' }; }
  providerRetryPolicy() { return undefined; }
  imageRequestPricing() { return undefined; }
  imageRequestTarget(_p, _m, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }
  async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: (o) => this.stream(o) }; }
  async listModels(provider) { return [{ provider, id: 'fixture-1', name: 'fixture-1' }]; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 8192 };
  }
  async *stream(options) {
    const { readFileSync, appendFileSync } = await import('node:fs');
    const scenario = JSON.parse(readFileSync(this.scenarioPath, 'utf8'));
    const system = typeof options.system === 'string' ? options.system : '';
    const sessionId = options.sessionId ?? 'unknown';
    if (system.startsWith('REVIEW_POLICY')) {
      const index = this.reviewerIndex ?? 0;
      this.reviewerIndex = index + 1;
      // A real wait window: the reviewer stays "thinking" for a controllable
      // time, so a lifecycle action can land while the review is in flight.
      const delayMs = Number(scenario.reviewerDelayMs ?? 0);
      if (delayMs > 0) await new Promise((resolve) => setTimeout(resolve, delayMs));
      const reply = scenario.reviewer?.[index] ?? scenario.reviewerDefault ?? {
        risk: 2, authorized: 6, secrets: false, destructive: false, egress: false, bulk: false,
      };
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      try {
        appendFileSync(this.scenarioPath.replace(/scenario\.json$/u, 'reviewer-requests.jsonl'),
          JSON.stringify({ at: new Date().toISOString(), index, sessionId, reply: text }) + '\n');
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
      appendFileSync(this.scenarioPath.replace(/scenario\.json$/u, 'agent-requests.jsonl'),
        JSON.stringify({ at: new Date().toISOString(), route: route.match ?? 'default', index, sessionId }) + '\n');
    } catch {}
    let blockIndex = 0;
    if (step.type === 'calls') {
      if (step.text !== undefined) {
        yield { type: 'block-start', index: blockIndex, blockType: 'text' };
        yield { type: 'text-delta', index: blockIndex, text: step.text };
        yield { type: 'block-end', index: blockIndex, block: { type: 'text', text: step.text } };
        blockIndex += 1;
      }
      for (const call of step.calls ?? []) {
        const id = `fx-${sessionId}-${index}-${this.sequence++}`;
        const args = JSON.stringify(call.arguments ?? {});
        yield { type: 'block-start', index: blockIndex, blockType: 'tool-call' };
        yield { type: 'tool-call-delta', index: blockIndex, id, name: call.name, argumentsDelta: args };
        yield { type: 'block-end', index: blockIndex, block: { type: 'tool-call', id, name: call.name, arguments: args } };
        blockIndex += 1;
      }
    } else {
      const text = step.text ?? '';
      yield { type: 'block-start', index: 0, blockType: 'text' };
      if (text.length > 0) yield { type: 'text-delta', index: 0, text };
      yield { type: 'block-end', index: 0, block: { type: 'text', text } };
    }
    yield { type: 'usage', usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    yield { type: 'finish', reason: { kind: 'stop' } };
  }
}

export function apply(ctx, config) {
  ctx.llm.registerAdapter([config.provider ?? 'pui'], new FixtureAdapter(config.scenarioPath));
}
export { name, inject };
