// Run after `mise exec -- pnpm build`. All writes stay in a fresh temporary home.
// This exercises real product modules with explicit fixtures; it does not claim
// to reproduce DSH Loader, a live model, or browser behavior end to end.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../../../lib/index.js';
import { evaluateCall } from '../../../lib/rules/match.js';
import { DEFAULT_CONFIG } from '../../../lib/config.js';
import { signalsFromChat, renderRequest, runDecisionReviewer } from '../../../lib/reviewer.js';
import { decideReview } from '../../../lib/policy.js';
import { buildReviewSnapshot } from '../../../lib/snapshot.js';
import { AuditStore } from '../../../lib/audit.js';
import { generateCandidates } from '../../../lib/suggestions.js';

const home = mkdtempSync(join(tmpdir(), 'arbiter-code-review-'));
const results = [];
const closers = [];
function check(id, description, passes, actual) {
  results.push({ id, description, passes, actual });
}
// The harness exercises the current rule model directly. Legacy conversion is
// covered by the unit and integration suites; here the fixture states the
// canonical shape so the cases test gate behaviour rather than migration.
function rule(id, node, kind, pattern, verdict = 'allow') {
  return { id, conditions: [{ target: node, kind, pattern }], verdict };
}
// A document carrying canonical rules must declare the canonical format.
function document(config) {
  return { format: 'arbiter-config-v2', ...config };
}
function record(callId, overrides = {}) {
  return {
    callId, ts: Date.now(), sessionId: 's', sessionKind: 'main', parentSession: null,
    profile: 'test', workspace: home, tool: 'bash', arguments: { command: 'echo harmless' },
    cwd: home, fingerprint: 'fp', configRevision: 'v', configSnapshotId: 'cfg',
    approvalMode: 'normal', executionMode: 'guarded', result: 'allow', reason: 'fixture',
    trace: [], effect: null, sessionRecordState: 'written', snapshot: null,
    modelAttempts: [], signals: null, policyStrategy: null, decisionRules: [],
    executionStatus: 'success', ...overrides,
  };
}
function context(profile, session, stream, options = {}) {
  const handlers = new Map(), routes = new Map(), disposers = [];
  const services = {
    profileContext: { home, dir: join(home, profile), name: profile },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => session }, llm: { stream },
    approval: { config: { policy: 'ask' }, request: async () => {
      options.prompts?.push(profile); return 'allowed-once';
    } },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: async () => home },
    connection: { fetch: { register(route) {
      routes.set(route.path, route); return () => routes.delete(route.path);
    } } }, ...options.services,
  };
  const ctx = {
    get: key => services[key],
    on(event, handler) { handlers.set(event, handler); return () => handlers.delete(event); },
    effect(fn) { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject(names, fn) { if (names.every(name => services[name])) return fn(ctx); },
    logger: { info() {}, warn() {}, error() {} },
  };
  let closed = false;
  const fixture = { ctx, handlers, routes, close() {
    if (closed) return; closed = true; for (const dispose of disposers) dispose();
  } };
  closers.push(() => fixture.close());
  return fixture;
}

try {
  const evaluation = evaluateCall({
    rules: [rule('cd', 'command', 'regex', '^cd(?:\\s|$)'),
      rule('echo', 'command', 'regex', '^echo(?:\\s|$)'),
      rule('workspace-only', 'file_redirect', 'glob', '/workspace/project/**')],
    tool: 'bash', arguments: { command: 'cd /outside && echo harmless > marker.txt' },
    identity: 'main', workspaceRoot: '/workspace/project', cwd: '/workspace/project',
    parentAuthorizationPresent: null, historyTruncated: false, overlapsDeniedEffect: false,
  });
  check('R1', 'A redirect after cd must not match the original workspace',
    evaluation.path.verdict !== 'allow', { path: evaluation.path, matches: evaluation.matches });

  const signals = signalsFromChat({ risk: 3, authorized: 0, secrets: false,
    destructive: false, egress: true, bulk: true }, 0);
  const decision = decideReview(signals, 'progress', DEFAULT_CONFIG.policy.progress);
  check('R2', 'Bulk egress in progress requires explicit authorization',
    decision.verdict !== 'review-allow', decision);

  const events = [], prompts = [];
  const session = { id: 's', header: { cwd: home }, snapshotEvents: () => events,
    append(type, data) { events.push({ type, data, seq: events.length + 1, time: Date.now() }); },
    requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }),
  };
  let release, started;
  const startedPromise = new Promise(resolve => { started = resolve; });
  const releasePromise = new Promise(resolve => { release = resolve; });
  const stream = async function* () {
    started(); await releasePromise;
    yield { type: 'text-delta', text: JSON.stringify({ risk: 5, authorized: 0,
      secrets: false, destructive: false, egress: false, bulk: false }) };
    yield { type: 'finish', reason: { kind: 'stop' } };
  };
  const old = context('A', session, stream, { prompts });
  apply(old.ctx, { modes: { main: 'normal', subagent: 'strict' } });
  const pending = old.handlers.get('tools/pre-execute')({ callId: 'pending', name: 'bash',
    arguments: { command: 'echo harmless' }, signal: new AbortController().signal,
    agent: { session } }, async () => ({ kind: 'allow' }));
  await startedPromise;
  old.close();
  const fresh = context('A', session, stream, { prompts });
  apply(fresh.ctx, { modes: { main: 'strict', subagent: 'strict' } });
  release();
  const pendingResult = await pending;
  // The session in this fixture is a bare stub, not a host Session, so the
  // public `appendPluginRecord` writer cannot commit to it. What R3 is about is
  // the unfinished review: it must not open an approval and must settle as
  // fallback-deny. The decision record is asserted where a real Session exists
  // (tests/records.test.ts and the F1 host run).
  check('R3', 'After applying strict, an unfinished review must not open a new approval',
    prompts.length === 0
      && pendingResult.kind === 'deny'
      && pendingResult.reason.includes('fallback-deny'),
    { prompts, pendingResult, recordedEvents: events.length });
  fresh.close();

  const deny = rule('profile-rule', 'command', 'regex', '^echo(?:\\s|$)', 'deny');
  const a = context('A', session, stream); apply(a.ctx, document({ rules: [deny] })); a.close();
  const b = context('B', session, stream); apply(b.ctx, document({ rules: [{ ...deny, verdict: 'allow' }] })); b.close();
  const invalidA = context('A', session, stream);
  apply(invalidA.ctx, document({ rules: [{ ...deny, conditions: [{ target: 'command', kind: 'regex', pattern: '(' }] }] }));
  const state = await (await invalidA.routes.get('/api/arbiter/state').fetch(new Request('http://fixture/state'))).json();
  check('R4', 'Invalid profile A must restore A rather than profile B',
    state.config.rules[0]?.verdict === 'deny', { restoredRule: state.config.rules[0], error: state.invalidConfigError });
  invalidA.close();

  const store = new AuditStore(join(home, 'retention.db'), DEFAULT_CONFIG.audit);
  closers.push(() => store.close());
  for (let i = 0; i < 10; i++) store.enqueue(record('retention-' + i, {
    arguments: { command: 'echo harmless', padding: 'x'.repeat(4000) },
  }));
  await store.flush();
  const before = store.databaseBytes, target = before - 16384;
  const deleted = store.runRetention(Date.now(), 30, target);
  check('R5', 'Capacity cleanup should retain recent records instead of deleting all without reclaiming space',
    store.listCalls().total > 0 && store.databaseBytes < before,
    { before, target, deleted, remaining: store.listCalls().total, after: store.databaseBytes });
  store.close();

  const config = structuredClone(DEFAULT_CONFIG);
  config.context.customRules = 'REVIEW_SENTINEL_USER_RULE'; config.context.projectRules.enabled = false;
  const longContent = 'Please perform the operation. ' + 'a'.repeat(4000) + ' Do not send anything outside this machine.';
  const humanSession = { id: 'human-session', header: { cwd: home }, snapshotEvents: () => [{
    seq: 1, time: 1, type: 'user/message', data: { source: { kind: 'user', rpcId: 'r' }, content: longContent },
  }] };
  const bundle = await buildReviewSnapshot({ agent: { session: humanSession }, tool: 'bash',
    arguments: { command: 'echo harmless' }, callId: 'snapshot', cwd: home, config,
    facts: null, priorVerdicts: [], sessionRecordGap: null });
  let requestBody;
  await runDecisionReviewer({ decision: { ...config.reviewer.decision, url: 'http://fixture.invalid', apiKeyRef: '' },
    thresholds: config.policy.normal, signal: new AbortController().signal,
    fetch: async (_url, options) => { requestBody = JSON.parse(options.body); return new Response('{}'); },
  }, bundle.snapshot, { user: bundle.user, estimatedInputTokens: bundle.estimatedInputTokens }, 'decision-check');
  check('R6', 'Both reviewer backends must receive global custom rules',
    JSON.stringify(requestBody).includes('REVIEW_SENTINEL_USER_RULE'), {
      chatContainsRule: renderRequest(bundle.snapshot).system.includes('REVIEW_SENTINEL_USER_RULE'),
      decisionContainsRule: JSON.stringify(requestBody).includes('REVIEW_SENTINEL_USER_RULE'),
    });
  check('R7', 'Truncated original human evidence must be marked incomplete',
    bundle.snapshot.evidenceTruncated === true, { originalLength: longContent.length,
      retainedLength: bundle.snapshot.evidence[0].text.length, evidenceTruncated: bundle.snapshot.evidenceTruncated,
      missing: bundle.snapshot.missing, retainedRestriction: bundle.snapshot.evidence[0].text.includes('Do not send') });

  const candidateRule = rule('candidate-rule', 'command', 'regex', '^printf(?:\\s|$)');
  const candidateStore = new AuditStore(join(home, 'arbiter', 'arbiter.db'), DEFAULT_CONFIG.audit);
  candidateStore.saveCandidate({ candidateId: 'candidate-one', createdAt: Date.now(), status: 'pending',
    rule: candidateRule, stats: {}, evidence: {}, windowStart: 0, windowEnd: Date.now(), note: null });
  candidateStore.close();
  let afterAccept, configured = {};
  const entry = { options: { id: 'arbiter', config: configured }, fiber: {} };
  const accepting = context('A', session, stream, { services: { configEditor: {
    documentPath: join(home, 'fixture-patch.json'), entries: () => [entry],
    async edit(_entry, change) {
      configured = change(configured, {});
      accepting.close(); afterAccept = context('A', session, stream); apply(afterAccept.ctx, configured);
    },
  } } });
  apply(accepting.ctx, {});
  let acceptError = null, acceptResponse = null;
  try {
    acceptResponse = await (await accepting.routes.get('/api/arbiter/suggestions/act').fetch(new Request('http://fixture/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: 'candidate-one', action: 'accept' }),
    }))).json();
  } catch (error) { acceptError = String(error); }
  const inspection = new AuditStore(join(home, 'arbiter', 'arbiter.db'), DEFAULT_CONFIG.audit);
  const candidateStatus = inspection.listCandidates().find(c => c.candidateId === 'candidate-one')?.status;
  inspection.close();
  check('R8', 'Accepting a suggestion must survive Loader reconciliation and mark the candidate accepted',
    acceptError === null && candidateStatus === 'accepted', {
      acceptError, acceptResponse, candidateStatus, ruleAdded: configured.rules?.some(r => r.id === candidateRule.id),
    });
  afterAccept?.close();

  const analysis = new AuditStore(join(home, 'analysis.db'), DEFAULT_CONFIG.audit);
  closers.push(() => analysis.close());
  for (let i = 0; i < 3; i++) analysis.enqueue(record('approved-' + i, { arguments: { command: 'git status' } }));
  analysis.enqueue(record('denied', { arguments: { command: 'git status --ignored' }, result: 'human-deny', executionStatus: 'not-started' }));
  await analysis.flush();
  const proposals = generateCandidates(analysis, { windowStart: 0, windowEnd: Date.now() + 1000,
    minOccurrences: 3, maxCandidates: 20 });
  check('R9', 'A command family with a denial must not be reported as always allowed',
    proposals.length === 0, proposals.map(p => ({ rule: p.rule, stats: p.stats })));
  analysis.close();
} finally {
  for (const close of closers.reverse()) close();
  rmSync(home, { recursive: true, force: true });
}
const report = { recordedAt: new Date().toISOString(), tests: results.length,
  failures: results.filter(r => !r.passes).length, results };
writeFileSync(fileURLToPath(new URL('./results.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
for (const result of results) console.log((result.passes ? 'PASS' : 'FAIL') + ' ' + result.id + ': ' + result.description);
process.exitCode = report.failures > 0 ? 1 : 0;
