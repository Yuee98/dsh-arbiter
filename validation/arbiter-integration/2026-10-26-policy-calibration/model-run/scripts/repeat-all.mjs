/**
 * Repeat every case a few times, so a single sample is not presented as a
 * model-quality fact where the model is unstable.
 *
 * Sends the identical request per repetition (same system, user payload, and
 * model), recording each answer. Cheap: these are small requests.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const repeats = Number(process.argv[3] ?? '3');

const apiKey = readFileSync(join(homedir(), '.keys', '.deepseek.local.key'), 'utf8').trim();
const { parseChatText, signalsFromChat } = await import(`${repo}/lib/reviewer/signals.js`);
const { renderRequest } = await import(`${repo}/lib/reviewer/prompt.js`);
const { DEFAULT_CONFIG } = await import(`${repo}/lib/config.js`);
const { decideReview } = await import(`${repo}/lib/policy.js`);

const all = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).cases;
const normal = DEFAULT_CONFIG.policy.normal;

function snapshotFor(entry) {
  return {
    version: 1, createdAt: 0, configRevision: 'repeat-all', callId: entry.id,
    sessionId: 'repeat-all', sessionKind: 'main', tool: 'bash', cwd: '/workspace/project',
    action: { name: 'bash', arguments: { command: entry.command } },
    facts: null, projectRules: null, customRules: '', materials: [],
    evidence: entry.evidence.map((text, i) => ({ source: 'human', role: 'user', text, id: 'e' + i, truncated: false, ceiling: 'explicit' })),
    evidenceTruncated: false, parentAuthorizationPresent: null, context: [], checkpoints: [],
    contextTruncated: false, priorVerdicts: [], historyTruncated: false,
    historyStatus: { coverage: 'known-empty', windowTruncated: false, reason: null, sources: { memory: { read: 0, unavailable: null }, session: { read: 0, unavailable: null }, audit: { read: 0, unavailable: null } }, reset: false },
    missing: [], budget: { maxInputTokens: 10000, estimatedInputTokens: 0, truncatedSegments: [] },
  };
}

const rows = [];
for (const entry of all) {
  const request = renderRequest(snapshotFor(entry));
  const observations = [];
  for (let i = 0; i < repeats; i += 1) {
    const started = Date.now();
    const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: 'deepseek-flash', max_tokens: 2000, system: request.system,
        messages: [{ role: 'user', content: request.user }],
      }),
    });
    const latencyMs = Date.now() - started;
    const json = await response.json();
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseChatText(text);
    let verdict = null;
    let signals = null;
    if (parsed.ok && parsed.raw !== undefined) {
      signals = signalsFromChat(parsed.raw, 0);
      verdict = decideReview(signals, 'normal', normal);
    }
    observations.push({
      latencyMs,
      status: response.status,
      parsed: parsed.ok ? parsed.raw : null,
      error: parsed.ok ? null : parsed.error,
      riskPoint: signals?.riskPoint ?? null,
      authPoint: signals?.authPoint ?? null,
      riskClass: signals?.riskClass ?? null,
      verdict: verdict?.verdict ?? null,
      kind: verdict === null ? 'unparsed' : verdict.verdict === 'review-allow' ? 'allow' : 'block',
      rules: verdict?.decisionRules ?? [],
      outputTokens: json.usage?.output_tokens ?? null,
    });
  }
  const kinds = {};
  for (const o of observations) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  const modal = Object.entries(kinds).sort((a, b) => b[1] - a[1])[0][0];
  const stable = Object.keys(kinds).length === 1;
  rows.push({
    id: entry.id,
    targets: entry.targets,
    command: entry.command,
    expected: entry.expect,
    ...(entry.knownGap === undefined ? {} : { knownGap: entry.knownGap }),
    repeats,
    kindCounts: kinds,
    modalKind: modal,
    stable,
    matchesLabelOnEveryRun: stable && modal === entry.expect.kind,
    modalMatchesLabel: modal === entry.expect.kind,
    latencyMs: {
      min: Math.min(...observations.map((o) => o.latencyMs)),
      max: Math.max(...observations.map((o) => o.latencyMs)),
    },
    observations,
  });
  const flag = stable ? (modal === entry.expect.kind ? 'ok  ' : 'DIFF') : 'VAR ';
  console.log(`${flag} ${entry.id.padEnd(32)} ${JSON.stringify(kinds)} expected=${entry.expect.kind} ${String(Math.min(...observations.map((o) => o.latencyMs)))}-${String(Math.max(...observations.map((o) => o.latencyMs)))}ms`);
}

const modelRows = rows.filter((r) => r.knownGap === undefined);
const gapRows = rows.filter((r) => r.knownGap !== undefined);
const report = {
  version: 1,
  ranAt: new Date().toISOString(),
  issue: 'Yuee98/dsh-arbiter#22',
  model: { provider: 'deepseek-official', id: 'deepseek-flash', endpoint: 'https://api.deepseek.com/anthropic/v1/messages', maxOutputTokens: 2000 },
  path: 'real arbiter chat adapter: renderRequest -> parseChatText -> signalsFromChat -> decideReview (each request built by the same renderer the plugin uses)',
  repeatsPerCase: repeats,
  cases: rows.length,
  modelQuality: {
    cases: modelRows.length,
    requests: modelRows.reduce((n, r) => n + r.repeats, 0),
    stableCases: modelRows.filter((r) => r.stable).length,
    unstableCases: modelRows.filter((r) => !r.stable).map((r) => r.id),
    matchedOnEveryRun: modelRows.filter((r) => r.matchesLabelOnEveryRun).length,
    matchedOnModalRun: modelRows.filter((r) => r.modalMatchesLabel).length,
  },
  knownGaps: gapRows.map((r) => ({
    id: r.id,
    gap: r.knownGap,
    expected: r.expected.kind,
    observed: r.kindCounts,
    stable: r.stable,
  })),
  rows,
};
writeFileSync(join(here, 'repeats.json'), `${JSON.stringify(report, null, 2)}\n`);
console.log(`\nmodel quality: ${modelRows.filter((r) => r.matchesLabelOnEveryRun).length}/${modelRows.length} matched on every run; ${modelRows.filter((r) => !r.stable).length} unstable; ${gapRows.length} documented gap`);
