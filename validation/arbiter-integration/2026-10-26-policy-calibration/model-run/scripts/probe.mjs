/**
 * One live request through the real arbiter chat adapter.
 *
 * The key is read from the file the operator approved, held only in memory, and
 * passed to the adapter through a resolved header — never printed, never written
 * to the artifact, never placed in an argument list.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const repo = process.argv[2];
const { runChatReviewer } = await import(`${repo}/lib/reviewer/chat.js`);
const { renderRequest } = await import(`${repo}/lib/reviewer/prompt.js`);
const { DEFAULT_CONFIG } = await import(`${repo}/lib/config.js`);
const { decideReview } = await import(`${repo}/lib/policy.js`);
const { PROBE_SNAPSHOT } = await import(`${repo}/lib/reviewer/diagnostic.js`);

const keyPath = join(homedir(), '.keys', '.deepseek.local.key');
const apiKey = readFileSync(keyPath, 'utf8').trim();
if (!apiKey.startsWith('sk-')) throw new Error('key file does not look like a key');

const config = {
  ...DEFAULT_CONFIG.reviewer.chat,
  provider: 'deepseek-official',
  model: 'deepseek-flash',
  maxTokens: 400,
  timeoutMs: 60_000,
};
const request = renderRequest(PROBE_SNAPSHOT);

/** The adapter seam the plugin uses: a stream of chunk records. */
const llm = {
  stream(options) {
    const body = JSON.stringify({
      model: options.model,
      max_tokens: options.maxTokens ?? 400,
      system: options.system,
      messages: options.messages.map((message) => ({
        role: message.role,
        content: message.content.map((part) => part.text).join('\n'),
      })),
    });
    return (async function* () {
      const started = Date.now();
      const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body,
        signal: options.signal,
      });
      const latency = Date.now() - started;
      if (!response.ok) {
        const text = await response.text();
        throw new Error(`HTTP ${response.status}: ${text.slice(0, 400)}`);
      }
      const json = await response.json();
      const text = (json.content ?? [])
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('');
      yield { type: 'usage', usage: json.usage ?? null };
      yield { type: 'text-delta', text };
      // The adapter contract ends a successful stream with a `finish` whose
      // reason kind is `stop`; the collector refuses a stream that never
      // terminates, which is what caught this probe's first shape.
      yield { type: 'finish', reason: { kind: 'stop' } };
      globalThis.__lastLatency = latency;
    })();
  },
};

const result = await runChatReviewer(
  {
    llm,
    chat: config,
    thresholds: DEFAULT_CONFIG.policy.normal,
    signal: AbortSignal.timeout(60_000),
  },
  PROBE_SNAPSHOT,
  request,
  'model-eval-probe',
);

console.log('ok:', result.ok);
if (result.ok) {
  console.log('signals:', JSON.stringify(result.signals));
  console.log('verdict:', decideReview(result.signals, 'normal', DEFAULT_CONFIG.policy.normal).decisionRules);
} else {
  console.log('error:', result.error);
}
for (const attempt of result.attempts ?? []) {
  console.log('attempt', attempt.attempt, 'durationMs', attempt.durationMs, 'error', attempt.error);
  console.log('raw:', (attempt.responseText ?? '').slice(0, 500));
}
