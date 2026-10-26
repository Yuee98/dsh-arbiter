import { readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
const repo = process.argv[2];
const ids = process.argv[3].split(',');
const repeats = Number(process.argv[4] ?? '8');
const apiKey = readFileSync(join(homedir(), '.keys', '.deepseek.local.key'), 'utf8').trim();
const { parseChatText, signalsFromChat } = await import(`${repo}/lib/reviewer/signals.js`);
const { renderRequest } = await import(`${repo}/lib/reviewer/prompt.js`);
const { DEFAULT_CONFIG } = await import(`${repo}/lib/config.js`);
const { decideReview } = await import(`${repo}/lib/policy.js`);
const all = JSON.parse(readFileSync(join(here, 'cases.json'), 'utf8')).cases;
const normal = DEFAULT_CONFIG.policy.normal;
function snapshotFor(entry) {
  return { version: 1, createdAt: 0, configRevision: 'repeat-many', callId: entry.id, sessionId: 'repeat-many', sessionKind: 'main', tool: 'bash', cwd: '/workspace/project', action: { name: 'bash', arguments: { command: entry.command } }, facts: null, projectRules: null, customRules: '', materials: [], evidence: entry.evidence.map((text, i) => ({ source: 'human', role: 'user', text, id: 'e' + i, truncated: false, ceiling: 'explicit' })), evidenceTruncated: false, parentAuthorizationPresent: null, context: [], checkpoints: [], contextTruncated: false, priorVerdicts: [], historyTruncated: false, historyStatus: { coverage: 'known-empty', windowTruncated: false, reason: null, sources: { memory: { read: 0, unavailable: null }, session: { read: 0, unavailable: null }, audit: { read: 0, unavailable: null } }, reset: false }, missing: [], budget: { maxInputTokens: 10000, estimatedInputTokens: 0, truncatedSegments: [] } };
}
const out = [];
for (const id of ids) {
  const entry = all.find((c) => c.id === id);
  const request = renderRequest(snapshotFor(entry));
  const obs = [];
  for (let i = 0; i < repeats; i += 1) {
    const started = Date.now();
    const response = await fetch('https://api.deepseek.com/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'deepseek-flash', max_tokens: 2000, system: request.system, messages: [{ role: 'user', content: request.user }] }),
    });
    const latencyMs = Date.now() - started;
    const json = await response.json();
    const text = (json.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const parsed = parseChatText(text);
    let kind = 'unparsed'; let rules = []; let signals = null;
    if (parsed.ok && parsed.raw !== undefined) {
      signals = signalsFromChat(parsed.raw, 0);
      const d = decideReview(signals, 'normal', normal);
      kind = d.verdict === 'review-allow' ? 'allow' : 'block';
      rules = d.decisionRules;
    }
    obs.push({ latencyMs, kind, rules, risk: signals?.riskPoint ?? null, authorized: signals?.authPoint ?? null, bulk: signals?.bulk ?? null, destructive: signals?.destructive ?? null, error: parsed.ok ? null : parsed.error });
    process.stdout.write(kind === 'allow' ? 'A' : kind === 'block' ? 'B' : '?');
  }
  const kinds = {};
  for (const o of obs) kinds[o.kind] = (kinds[o.kind] ?? 0) + 1;
  console.log(` ${id} ${JSON.stringify(kinds)}`);
  out.push({ id, command: entry.command, expected: entry.expect.kind, repeats, kindCounts: kinds, observations: obs });
}
writeFileSync(join(here, 'repeat-many.json'), `${JSON.stringify({ model: 'deepseek-flash', maxOutputTokens: 2000, cases: out }, null, 2)}\n`);
