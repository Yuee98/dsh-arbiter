/**
 * Deterministic LLM adapter with a real release barrier.
 *
 * Agent turns replay a scripted tool-call sequence. Reviewer requests are
 * recognised by the arbiter review system prompt and are **held open** until a
 * barrier file appears, so a driver can observe a genuinely in-flight review
 * instead of guessing from timing.
 *
 * Barrier protocol (all files under the case dir):
 *   <case>/barrier/<callId>-started.json    written before the wait
 *   <case>/barrier/<callId>-release         the driver creates this to release
 *   <case>/barrier/<callId>-finished.json   written after the reply is produced
 *
 * `callId` is taken from the request's own `requestId` prefix (`<callId>:model:N`),
 * which the plugin already passes to `llm.stream`. No plugin change is needed.
 *
 * This is a FIXTURE: it makes no model decision.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const name = 'barrier-llm';
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

/**
 * Claim the arbiter callId for this review.
 *
 * The plugin records `review/start` with the real callId just before it asks
 * the model, so the trace file is the authoritative source. Each callId is
 * claimed once, which keeps concurrent held reviews distinct.
 */
/** Look up the sessionId the plugin recorded for a callId. */
function claimSessionId(tracePath, callId) {
  if (tracePath === undefined || tracePath === '' || callId === '') return 'unknown';
  try {
    for (const line of readFileSync(tracePath, 'utf8').split('\n')) {
      if (line === '') continue;
      const entry = JSON.parse(line);
      if (entry.event === 'review/start' && entry.callId === callId && typeof entry.sessionId === 'string') {
        return entry.sessionId;
      }
    }
  } catch {
    // Unknown session falls through.
  }
  return 'unknown';
}

/** The pending action's own JSON line, which carries its arguments. */
function pendingActionText(messages) {
  const text = (messages ?? [])
    .map((m) => (Array.isArray(m.content) ? m.content : []).filter((b) => b && b.type === 'text').map((b) => b.text).join(''))
    .join('\n');
  const at = text.lastIndexOf('PENDING_ACTION');
  if (at === -1) return '';
  const rest = text.slice(at + 'PENDING_ACTION'.length);
  // The section ends at the next known header, so its JSON may span lines.
  const end = rest.search(/\n(?:REVIEW_HINT|DERIVED_FACTS|MISSING_INPUT|PRIOR_VERDICTS)\b/u);
  return end === -1 ? rest : rest.slice(0, end);
}

function claimCallId(tracePath, claimed) {
  if (tracePath === undefined || tracePath === '') return 'unknown-call';
  try {
    const lines = readFileSync(tracePath, 'utf8').split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const entry = JSON.parse(lines[i]);
      if (entry.event !== 'review/start') continue;
      const id = entry.callId;
      if (typeof id !== 'string' || claimed.has(id)) continue;
      claimed.add(id);
      return id;
    }
  } catch {
    // Fall through to the synthetic id below.
  }
  return `review-${String(claimed.size)}`;
}

class FixtureAdapter {
  constructor(scenarioPath) {
    this.scenarioPath = scenarioPath;
    this.sequence = 0;
    this.reviewerIndex = 0;
    this.claimed = new Set();
    this.caseDir = dirname(scenarioPath);
  }
  providerInfo(provider) { return { id: provider, name: 'Barrier Fixture' }; }
  providerRetryPolicy() { return undefined; }
  imageRequestPricing() { return undefined; }
  imageRequestTarget(_p, _m, image) { return { width: image.width, height: image.height, maxBytes: image.bytes }; }
  async prepareCall(provider, model) { return { model: await this.resolveModel(provider, model), stream: (o) => this.stream(o) }; }
  async listModels(provider) { return [{ provider, id: 'fixture-1', name: 'fixture-1' }]; }
  async resolveModel(provider, model) {
    return { provider, id: model, name: model, context: { contextWindow: 200000 }, defaultMaxTokens: 8192 };
  }

  async *stream(options) {
    const scenario = JSON.parse(readFileSync(this.scenarioPath, 'utf8'));
    const system = typeof options.system === 'string' ? options.system : '';
    const sessionId = options.sessionId ?? 'unknown';
    const barrierDir = join(scenario.barrierDir ?? this.caseDir, 'barrier');
    mkdirSync(barrierDir, { recursive: true });
    const t0 = Date.now();

    if (system.startsWith('REVIEW_POLICY')) {
      const callId = claimCallId(process.env['ARBITER_TRACE_PATH'], this.claimed);
      const claimedSession = claimSessionId(process.env['ARBITER_TRACE_PATH'], callId);
      const index = this.reviewerIndex ?? 0;
      this.reviewerIndex = index + 1;
      // 1. record that the review has STARTED, before any wait
      writeFileSync(join(barrierDir, `${callId}-started.json`), JSON.stringify({
        callId, sessionId: claimedSession, index, at: new Date().toISOString(), t: t0,
      }));
      appendFileSync(join(barrierDir, 'timeline.jsonl'), JSON.stringify({
        event: 'review-started', callId, sessionId: claimedSession, t: t0,
      }) + '\n');

      // 2. hold until the driver releases this exact call
      const releasePath = join(barrierDir, `${callId}-release`);
      const mode = scenario.releaseMode ?? 'file';
      const timeoutMs = Number(scenario.barrierTimeoutMs ?? 120000);
      // Warm-up calls never need to be held: holding them would stall the
      // session before the scenario under test even begins.
      //
      // Only the PENDING_ACTION line is inspected. Scanning the whole request
      // would also match earlier turns that are replayed as context, which
      // would silently auto-release the call actually under test.
      const pending = pendingActionText(options.messages);
      const hold = (scenario.holdMatch ?? []).some((m) => typeof m === 'string' && pending.includes(m));
      const autoRelease = !hold;
      appendFileSync(join(barrierDir, 'decisions.jsonl'), JSON.stringify({
        callId, hold, pending: pending.slice(0, 300), at: Date.now(),
      }) + '\n');
      if (autoRelease) writeFileSync(releasePath, 'auto\n');
      if (process.env['BARRIER_DEBUG'] === '1') {
        appendFileSync(join(barrierDir, 'debug.txt'), `${callId} auto=${String(autoRelease)} pending=${pendingActionText(options.messages).slice(0, 200)}\n`);
      }
      if (mode === 'file') {
        while (!existsSync(releasePath) && Date.now() - t0 < timeoutMs) {
          await new Promise((r) => setTimeout(r, 25));
        }
      }
      // 3. record the release moment and produce the reply
      const released = existsSync(releasePath);
      appendFileSync(join(barrierDir, 'timeline.jsonl'), JSON.stringify({
        event: 'review-released', callId, sessionId: claimedSession, released, waitedMs: Date.now() - t0, t: Date.now(),
      }) + '\n');
      const reply = scenario.reviewer?.[index] ?? scenario.reviewerDefault ?? {
        risk: 2, authorized: 6, secrets: false, destructive: false, egress: false, bulk: false,
      };
      const text = typeof reply === 'string' ? reply : JSON.stringify(reply);
      writeFileSync(join(barrierDir, `${callId}-finished.json`), JSON.stringify({
        callId, sessionId: claimedSession, index, at: new Date().toISOString(), reply: text,
      }));
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
    appendFileSync(join(barrierDir, 'timeline.jsonl'), JSON.stringify({
      event: 'agent-step', route: route.match ?? 'default', index, sessionId, t: Date.now(),
    }) + '\n');
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
