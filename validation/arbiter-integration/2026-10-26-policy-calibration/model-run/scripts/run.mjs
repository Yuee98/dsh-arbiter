/**
 * Run the representative sample set through the real arbiter chat adapter.
 *
 * This exercises the production path #22 cares about: the same `renderRequest`
 * the plugin sends, the same `runChatReviewer` that validates and repairs the
 * answer, and the same `decideReview` that turns signals into a verdict. Only the
 * transport is local (a fetch in this file), because the goal is to observe what
 * a real model does with the real request, not to re-test the host's HTTP client.
 *
 * The key is read from the operator-approved file, held in memory, and never
 * written, printed, or placed in an artifact. Every recorded request has its
 * `x-api-key` and `authorization` replaced with `<redacted>`.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2] ?? join(here, '../../../..');
const { runChatReviewer } = await import(`${repo}/lib/reviewer/chat.js`);
const { renderRequest } = await import(`${repo}/lib/reviewer/prompt.js`);
const { DEFAULT_CONFIG } = await import(`${repo}/lib/config.js`);
const { decideReview } = await import(`${repo}/lib/policy.js`);

const apiKey = readFileSync(join(homedir(), '.keys', '.deepseek.local.key'), 'utf8').trim();
if (!apiKey.startsWith('sk-')) throw new Error('key file does not look like a key');

const MODEL = 'deepseek-flash';
const PROVIDER = 'deepseek-official';
const ENDPOINT = 'https://api.deepseek.com/anthropic/v1/messages';
const cases = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).cases;
const normal = DEFAULT_CONFIG.policy.normal;

/** Redact anything credential-shaped before a request leaves this function. */
function redact(text) {
  return text
    .replace(/x-api-key[^,\n]*/gi, 'x-api-key: <redacted>')
    .replace(/authorization[^,\n]*/gi, 'authorization: <redacted>')
    .replace(/sk-[A-Za-z0-9_-]{8,}/g, '<redacted>');
}

function snapshotFor(entry) {
  return {
    version: 1,
    createdAt: 0,
    configRevision: 'model-eval',
    callId: entry.id,
    sessionId: 'model-eval',
    sessionKind: 'main',
    tool: 'bash',
    cwd: '/workspace/project',
    action: { name: 'bash', arguments: { command: entry.command } },
    facts: null,
    projectRules: null,
    customRules: '',
    materials: [],
    evidence: entry.evidence.map((text, index) => ({
      source: 'human',
      role: 'user',
      text,
      id: `e${String(index + 1)}`,
      truncated: false,
      ceiling: 'explicit',
    })),
    evidenceTruncated: false,
    parentAuthorizationPresent: null,
    context: [],
    checkpoints: [],
    contextTruncated: false,
    priorVerdicts: [],
    historyTruncated: false,
    historyStatus: {
      coverage: 'known-empty',
      windowTruncated: false,
      reason: null,
      sources: {
        memory: { read: 0, unavailable: null },
        session: { read: 0, unavailable: null },
        audit: { read: 0, unavailable: null },
      },
      reset: false,
    },
    missing: [],
    budget: { maxInputTokens: 10_000, estimatedInputTokens: 0, truncatedSegments: [] },
  };
}

const chatConfig = {
  ...DEFAULT_CONFIG.reviewer.chat,
  provider: PROVIDER,
  model: MODEL,
  maxTokens: Number(process.env.EVAL_MAX_TOKENS ?? '400'),
  timeoutMs: 120_000,
  maxRepairRetries: 1,
};

const results = [];
for (const entry of cases) {
  const snapshot = snapshotFor(entry);
  const request = renderRequest(snapshot);
  const captured = [];
  const started = Date.now();

  const llm = {
    stream(options) {
      const body = {
        model: options.model,
        max_tokens: options.maxTokens ?? 400,
        system: options.system,
        messages: options.messages.map((message) => ({
          role: message.role,
          content: message.content.map((part) => part.text).join('\n'),
        })),
      };
      captured.push({ endpoint: ENDPOINT, body });
      return (async function* () {
        const response = await fetch(ENDPOINT, {
          method: 'POST',
          headers: {
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
            'content-type': 'application/json',
          },
          body: JSON.stringify(body),
          signal: options.signal,
        });
        if (!response.ok) {
          const text = await response.text();
          throw new Error(`HTTP ${String(response.status)}: ${text.slice(0, 300)}`);
        }
        const json = await response.json();
        const text = (json.content ?? [])
          .filter((block) => block.type === 'text')
          .map((block) => block.text)
          .join('');
        yield { type: 'usage', usage: json.usage ?? null };
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };

  const result = await runChatReviewer(
    { llm, chat: chatConfig, thresholds: normal, signal: AbortSignal.timeout(180_000) },
    snapshot,
    request,
    entry.id,
  );

  const latencyMs = Date.now() - started;
  const attempts = (result.attempts ?? []).map((attempt) => ({
    attempt: attempt.attempt,
    durationMs: attempt.durationMs,
    error: attempt.error === null ? null : redact(String(attempt.error)),
    responseText: attempt.responseText === null ? null : redact(attempt.responseText),
    parsed: attempt.parsed,
    usage: attempt.usage,
  }));

  const verdict = result.ok
    ? decideReview(result.signals, 'normal', normal)
    : null;
  const actualKind = verdict === null ? 'unparsed' : verdict.verdict === 'review-allow' ? 'allow' : 'block';

  results.push({
    id: entry.id,
    targets: entry.targets,
    command: entry.command,
    evidence: entry.evidence,
    expected: entry.expect,
    actual: {
      ok: result.ok,
      verdict: verdict?.verdict ?? null,
      rules: verdict?.decisionRules ?? [],
      reason: verdict?.reason ?? null,
      signals: result.ok ? result.signals : null,
      error: result.ok ? null : redact(String(result.error)),
      kind: actualKind,
    },
    matchesLabel: actualKind === entry.expect.kind,
    // A case whose miss is a documented engine limitation rather than model
    // error is counted apart, so the two never inflate each other.
    ...(entry.knownGap === undefined ? {} : { knownGap: entry.knownGap }),
    latencyMs,
    attempts,
    request: {
      provider: PROVIDER,
      model: MODEL,
      endpoint: ENDPOINT,
      // The key header is never part of the recorded request.
      headers: { 'x-api-key': '<redacted>', 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      system: redact(request.system),
      user: redact(request.user),
      estimatedInputTokens: request.estimatedInputTokens,
    },
    sentBody: captured.map((item) => redact(JSON.stringify(item.body))),
  });

  const mark =
    entry.knownGap !== undefined
      ? 'GAP '
      : actualKind === entry.expect.kind
        ? 'ok  '
        : 'DIFF';
  console.log(`${mark} ${entry.id.padEnd(32)} expected=${entry.expect.kind.padEnd(5)} actual=${actualKind.padEnd(8)} ${String(latencyMs).padStart(6)}ms ${verdict?.decisionRules.join(',') ?? '-'}`);
}

const modelCases = results.filter((entry) => entry.knownGap === undefined);
const knownGaps = results.filter((entry) => entry.knownGap !== undefined);
const matched = modelCases.filter((entry) => entry.matchesLabel).length;
const report = {
  version: 1,
  ranAt: new Date().toISOString(),
  issue: 'Yuee98/dsh-arbiter#22',
  model: { provider: PROVIDER, id: MODEL, endpoint: ENDPOINT, protocol: 'Anthropic Messages API (streamed, non-stream body)' },
  path:
    'real arbiter chat adapter: renderRequest -> runChatReviewer -> parseChatText -> signalsFromChat -> decideReview',
  sampleSize: results.length,
  modelQuality: {
    cases: modelCases.length,
    matched,
    differed: modelCases.length - matched,
  },
  knownGaps: knownGaps.map((entry) => ({
    id: entry.id,
    gap: entry.knownGap,
    expected: entry.expected.kind,
    actual: entry.actual.kind,
    rules: entry.actual.rules,
  })),
  failures: results.filter((entry) => !entry.actual.ok).length,
  latencyMs: {
    min: Math.min(...results.map((entry) => entry.latencyMs)),
    max: Math.max(...results.map((entry) => entry.latencyMs)),
    median: [...results.map((entry) => entry.latencyMs)].sort((a, b) => a - b)[Math.floor(results.length / 2)],
    all: results.map((entry) => ({ id: entry.id, latencyMs: entry.latencyMs })),
  },
  results,
};
writeFileSync(join(here, process.env.EVAL_OUT ?? 'results.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(
  `\nmodel quality: ${matched}/${modelCases.length} matched; ${modelCases.length - matched} differed; ${report.failures} request failures; ${knownGaps.length} documented gap case(s) counted separately`,
);
process.exitCode = 0;
