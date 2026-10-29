// First-release scope regression (issue #20). Run after `pnpm build`.
// All writes stay in a fresh temporary home.
//
// This runner is separate from validation/codex-review/2026-10-21/reproduce.mjs
// on purpose: that file and its results.json are historical evidence and stay
// byte-identical. Its R8 covers a prototype accept flow that this release
// deliberately removes, so this file states the current contract instead.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { apply } from '../../../lib/index.js';
import { DEFAULT_CONFIG } from '../../../lib/config.js';
import { AuditStore } from '../../../lib/audit.js';

const home = mkdtempSync(join(tmpdir(), 'arbiter-first-release-scope-'));
const results = [];
function check(id, description, passes, actual) {
  results.push({ id, description, passes, actual });
}
function context(profile, session, extraServices = {}) {
  const routes = new Map();
  const disposers = [];
  const services = {
    profileContext: { home, dir: join(home, profile), name: profile },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: { get: () => session },
    approval: { config: { policy: 'ask' }, request: async () => 'unavailable' },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: async () => home },
    connection: { fetch: { register(route) {
      routes.set(route.path, route);
      return () => routes.delete(route.path);
    } } },
    ...extraServices,
  };
  const ctx = {
    get: key => services[key],
    on: () => () => {},
    effect: fn => { const dispose = fn(); if (typeof dispose === 'function') disposers.push(dispose); },
    inject: (names, fn) => { if (names.every(name => services[name])) return fn(ctx); },
    logger: { info() {}, warn() {}, error() {} },
  };
  return { ctx, routes, close() { for (const dispose of disposers.splice(0)) dispose(); } };
}

try {
  const session = { id: 's', header: { cwd: home }, snapshotEvents: () => [], append() {},
    requestHeader: () => ({ config: { provider: 'fixture', model: 'fixture' } }) };
  // The document states the canonical shape explicitly, so these cases exercise
  // the release behaviour rather than legacy conversion.
  const seededRule = { id: 'keep-me', conditions: [{ target: 'command', kind: 'regex', pattern: 'gh pr view(?: .*)?' }], verdict: 'allow' };
  const configured = { format: 'arbiter-config-v3', rules: [seededRule], audit: DEFAULT_CONFIG.audit };

  // Historical rows must survive the scope change: one audited call and one
  // pending candidate written before the plugin starts.
  const seed = new AuditStore(join(home, 'arbiter', 'arbiter.db'), configured.audit);
  seed.enqueue({ callId: 'existing-call', ts: Date.now(), sessionId: 's', sessionKind: 'main',
    parentSession: null, profile: 'scope', workspace: home, tool: 'bash',
    arguments: { command: 'gh pr view 42' }, cwd: home, fingerprint: 'fp',
    configRevision: 'rev', configSnapshotId: 'cfg', approvalMode: 'normal',
    executionMode: 'guarded', result: 'review-allow', reason: 'kept',
    trace: [], effect: null, sessionRecordState: 'written', snapshot: null,
    modelAttempts: [], signals: null, policyStrategy: null, decisionRules: [],
    executionStatus: 'success' });
  seed.saveCandidate({ candidateId: 'candidate-one', createdAt: Date.now(), status: 'pending',
    rule: { id: 'candidate-rule', match: { node: 'command', kind: 'regex', pattern: '^printf(?:\\s|$)' }, verdict: 'allow' },
    stats: {}, evidence: {}, windowStart: 0, windowEnd: Date.now(), note: null });
  await seed.flush();
  seed.close();

  const entry = { options: { id: 'arbiter', config: configured }, fiber: {} };
  const edits = [];
  const started = context('A', session, { configEditor: {
    documentPath: join(home, 'fixture-patch.json'),
    entries: () => [entry],
    edit: async () => { edits.push('edit'); },
  } });
  apply(started.ctx, configured);

  // S1: the four suggestion endpoints are not registered at all.
  const removed = ['/api/arbiter/suggestions', '/api/arbiter/analyze',
    '/api/arbiter/replay', '/api/arbiter/suggestions/act'];
  check('S1', 'Offline suggestion routes are absent from the public surface',
    removed.every(path => !started.routes.has(path)), {
      missing: removed.filter(path => !started.routes.has(path)),
      registered: [...started.routes.keys()],
    });

  // S2: an attempted acceptance cannot reach the configuration editor, and the
  // seeded candidate plus the effective rule stay untouched.
  let acceptStatus = null, acceptBody = null;
  const acceptRoute = started.routes.get('/api/arbiter/suggestions/act');
  if (acceptRoute !== undefined) {
    const response = await acceptRoute.fetch(new Request('http://fixture/accept', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ candidateId: 'candidate-one', action: 'accept' }),
    }));
    acceptStatus = response.status;
    acceptBody = await response.text();
  }
  const inspection = new AuditStore(join(home, 'arbiter', 'arbiter.db'), configured.audit);
  const candidateStatus = inspection.listCandidates().find(c => c.candidateId === 'candidate-one')?.status;
  const auditTotal = inspection.listCalls({}).total;
  inspection.close();
  check('S2', 'An attempted acceptance is unroutable and leaves candidates and rules unchanged',
    acceptRoute === undefined && edits.length === 0 && candidateStatus === 'pending'
      && configured.rules.length === 1 && configured.rules[0].id === 'keep-me', {
      routeRegistered: acceptRoute !== undefined, acceptStatus, acceptBody, edits,
      candidateStatus, ruleIds: configured.rules.map(rule => rule.id),
    });

  // S3: first-release operations still work and the seeded audit row survives.
  const testRoute = started.routes.get('/api/arbiter/test');
  const logsRoute = started.routes.get('/api/arbiter/logs');
  const tested = testRoute === undefined ? null
    : await (await testRoute.fetch(new Request('http://fixture/test', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ inputs: ['gh pr view 42'] }),
      }))).json();
  const logs = logsRoute === undefined ? null
    : await (await logsRoute.fetch(new Request('http://fixture/logs?limit=10'))).json();
  check('S3', 'Rule testing and logs keep working while the seeded call row is retained',
    tested?.ok === true && JSON.stringify(tested).includes('keep-me')
      && logs?.ok === true && logs.total === 1
      && JSON.stringify(logs).includes('existing-call') && auditTotal === 1, {
      testOk: tested?.ok ?? null, ruleMatched: JSON.stringify(tested ?? {}).includes('keep-me'),
      logsOk: logs?.ok ?? null, logsTotal: logs?.total ?? null, auditTotal,
    });

  started.close();
} finally {
  rmSync(home, { recursive: true, force: true });
}

const report = { recordedAt: new Date().toISOString(), tests: results.length,
  failures: results.filter(result => !result.passes).length, results };
writeFileSync(fileURLToPath(new URL('./results.json', import.meta.url)), JSON.stringify(report, null, 2) + '\n');
for (const result of results) console.log((result.passes ? 'PASS' : 'FAIL') + ' ' + result.id + ': ' + result.description);
process.exitCode = report.failures > 0 ? 1 : 0;
