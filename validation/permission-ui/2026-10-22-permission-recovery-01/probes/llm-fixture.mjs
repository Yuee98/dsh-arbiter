import { readFileSync } from "node:fs";

/**
 * Deterministic LLM adapter fixture for host-coverage validation.
 *
 * This is a TEST fixture, not a model. It replays a scenario file:
 *   { "default": [step...], "routes": [{ "match": "TAG", "steps": [step...] }] }
 * A route is selected by scanning every user message for `match`
 * (first route wins). The step index is the number of assistant messages in
 * the request, so the same session deterministically advances.
 *
 * Step shapes:
 *   { "type": "text",  "text": "..." }
 *   { "type": "calls", "calls": [{ "name": "bash", "arguments": {...} }], "text": "...?" }
 */

const name = "hostcov-llm-fixture";
const inject = ["llm"];

function textOfBlocks(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block) => block && block.type === "text")
    .map((block) => block.text)
    .join("\n");
}

function allUserText(messages) {
  const parts = [];
  for (const message of messages ?? []) {
    if (message.role !== "user") continue;
    parts.push(textOfBlocks(message.content));
  }
  return parts.join("\n");
}

function lastAssistantOfTool(messages, name) {
  const out = [];
  for (const message of messages ?? []) {
    if (message.role !== "assistant") continue;
    for (const block of message.content ?? []) {
      if (block.type !== "tool-call" || block.name !== name) continue;
      out.push(block.arguments);
    }
  }
  return out;
}

function selectRoute(scenario, messages) {
  // Newest user message wins: a route names the turn it scripts, so earlier
  // turns already in history must not re-select their script.
  const users = (messages ?? []).filter((message) => message.role === "user");
  for (let index = users.length - 1; index >= 0; index -= 1) {
    const text = textOfBlocks(users[index].content);
    for (const route of scenario.routes ?? []) {
      if (typeof route.match === "string" && text.includes(route.match)) return route;
    }
  }
  return { steps: scenario.default ?? [] };
}

function stepIndex(messages, match) {
  // Count assistant messages AFTER the FIRST user message that selected this
  // route. Anchoring on the first match keeps one script per route even when
  // the host later appends synthetic user messages (subagent-settled notices
  // and the like) that would otherwise reset the count and replay call steps.
  // A forked child starts from a seeded parent history, so the child's own
  // match string is what anchors it.
  let anchor = -1;
  const list = messages ?? [];
  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (message.role !== "user") continue;
    if (typeof match !== "string" || textOfBlocks(message.content).includes(match)) {
      anchor = index;
      break;
    }
  }
  let n = 0;
  for (let index = anchor + 1; index < list.length; index += 1) {
    if (list[index].role === "assistant") n += 1;
  }
  return n;
}

class FixtureAdapter {
  constructor(scenarioPath) {
    this.scenarioPath = scenarioPath;
    this.sequence = 0;
  }

  providerInfo(provider) {
    return { id: provider, name: "Host Coverage Fixture" };
  }

  providerRetryPolicy(_provider) {
    return undefined;
  }

  imageRequestPricing(_provider, _model) {
    return undefined;
  }

  imageRequestTarget(_provider, _model, image) {
    return { width: image.width, height: image.height, maxBytes: image.bytes };
  }

  /** Bind model metadata and the stream entry point for one registration. */
  async prepareCall(provider, model, signal) {
    return { model: await this.resolveModel(provider, model, signal), stream: (options) => this.stream(options) };
  }

  async listModels(provider) {
    return [{ provider, id: "fixture-1", name: "fixture-1" }];
  }

  async resolveModel(provider, model, _signal) {
    return {
      provider,
      id: model,
      name: model,
      context: { contextWindow: 200000 },
      defaultMaxTokens: 8192
    };
  }

  async *stream(options) {
    const scenario = JSON.parse(readFileSync(this.scenarioPath, "utf8"));
    const route = selectRoute(scenario, options.messages);
    const index = stepIndex(options.messages, route.match);
    try {
      const { appendFileSync } = await import("node:fs");
      appendFileSync(
        this.scenarioPath.replace(/scenario\.json$/u, "requests.jsonl"),
        JSON.stringify({
          at: new Date().toISOString(),
          provider: options.provider,
          model: options.model,
          route: route.match ?? "default",
          index,
          messages: (options.messages ?? []).map((message) => ({
            role: message.role,
            sourceKind: message.source?.kind ?? null,
            text: textOfBlocks(message.content).slice(0, 120)
          }))
        }) + String.fromCharCode(10)
      );
    } catch {}
    const step = (route.steps ?? [])[index] ?? { type: "text", text: "[fixture] out of scripted steps" };
    const sessionId = options.sessionId ?? "unknown";

    if (step.type === "text" || step.text !== undefined) {
      yield { type: "block-start", index: 0, blockType: "text" };
      const text = step.text ?? "";
      if (text.length > 0) yield { type: "text-delta", index: 0, text };
      yield { type: "block-end", index: 0, block: { type: "text", text } };
    }

    if (step.type === "calls") {
      let blockIndex = step.type === "text" || step.text !== undefined ? 1 : 0;
      for (const call of step.calls ?? []) {
        const id = `fixture-${sessionId}-${index}-${this.sequence++}`;
        const args = JSON.stringify(call.arguments ?? {});
        yield { type: "block-start", index: blockIndex, blockType: "tool-call" };
        yield { type: "tool-call-delta", index: blockIndex, id, name: call.name, argumentsDelta: args };
        yield {
          type: "block-end",
          index: blockIndex,
          block: { type: "tool-call", id, name: call.name, arguments: args }
        };
        blockIndex += 1;
      }
    }

    yield { type: "usage", usage: { inputTokens: 100, outputTokens: 10, totalTokens: 110 } };
    yield { type: "finish", reason: { kind: "stop" } };
  }
}

export function apply(ctx, config) {
  const provider = config.provider ?? "hostcov";
  ctx.llm.registerAdapter([provider], new FixtureAdapter(config.scenarioPath));
}

export { name, inject };
