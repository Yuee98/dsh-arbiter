/**
 * The unified call detail against real SQLite and real session records.
 *
 * What is pinned here, all through the plugin's own gate, settlement, audit store
 * and session-record writer:
 *
 *   - a full audit row is projected with its stored chain, historical rule name,
 *     snapshot and every model attempt;
 *   - the final permission verdict and the host execution result stay separate
 *     facts, and an unobserved execution is reported as such;
 *   - when the audit row is gone, the same call id still resolves from the
 *     runtime window or the committed session log, with the gap named;
 *   - a cleared record, an old row missing columns, a record format newer than
 *     this build and a call no source holds all have distinct outcomes;
 *   - a cancelled approval is reported as cancelled rather than as a denial;
 *   - stored request material is returned without authentication headers.
 *
 * No case uses today's configuration to fill in a past decision: the only rule
 * name shown is the one the row recorded.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import type { CallRecord } from '../../src/audit.js';
import { apply } from '../../src/index.js';
import { logRoute } from '../../src/host/audit-routes.js';
import { installSessionRecordApi } from '../../src/records.js';
import type { HostEnvironment } from '../../src/host/types.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import { capturingGate, createStubContext } from '../helpers/host-stub.js';
import type { Gate } from '../helpers/host-stub.js';
import {
  admitSession,
  recordingSessionApi,
} from '../helpers/session-records.js';

const homes: string[] = [];
let previousHome: string | undefined;
let seq = 0;

beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-detail-'));
  homes.push(home);
  process.env['DSH_HOME'] = home;
  seq += 1;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = previousHome;
  for (const home of homes.splice(0))
    await rm(home, { recursive: true, force: true });
});

interface StubSession {
  readonly id: string;
  readonly header: { readonly id: string; readonly cwd: string };
  readonly events: SessionEventLike[];
  readonly snapshotEvents: () => readonly SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  requestHeader(): {
    readonly config: { readonly provider: string; readonly model: string };
  };
}

function makeSession(id: string): StubSession {
  const events: SessionEventLike[] = [];
  return {
    id,
    header: { id, cwd: process.cwd() },
    events,
    append(type, data) {
      events.push({
        type,
        seq: events.length,
        data,
        ignorable: type.startsWith('plugin:'),
        time: Date.now(),
      });
    },
    snapshotEvents: () => events,
    requestHeader: () => ({ config: { provider: 'stub', model: 'stub' } }),
  };
}

/** A chat reviewer answer that keeps the call on the normal review path. */
function chatAnswer(risk: number, authorization: number) {
  // The current contract asks for exactly two integers; a third member would be
  // rejected as an unreadable answer and turn the call into a review failure.
  const text = JSON.stringify({ risk, authorization });
  return {
    stream: () => {
      return (async function* () {
        await Promise.resolve();
        yield { type: 'text-delta', text };
        yield { type: 'finish', reason: { kind: 'stop' } };
      })();
    },
  };
}

interface Harness {
  readonly host: HostEnvironment;
  readonly gate: Gate;
  readonly session: StubSession;
  readonly applyConfig: (config: unknown) => void;
}

function startHarness(
  options: {
    readonly approval?: (
      request: unknown,
    ) => Promise<'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'>;
    readonly session?: StubSession;
    /** Use the decision backend, whose credential resolution can fail early. */
    readonly decisionReviewer?: boolean;
    readonly credentials?: {
      resolve(ref: string): Promise<{ value: string } | undefined>;
    };
  } = {},
): Harness {
  const session = options.session ?? makeSession(`session-${String(seq)}`);
  const capture = capturingGate();
  const { ctx } = createStubContext(
    {
      profileContext: {
        home: process.env['DSH_HOME'] ?? '',
        dir: process.cwd(),
        name: `detail-${String(seq)}-${String(Date.now())}`,
      },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      sessions: {
        get: (id: string) => (id === session.id ? session : undefined),
        list: () => [session],
      },
      llm: chatAnswer(2, 9),
      approval: {
        config: { policy: 'ask' },
        request: options.approval ?? (() => Promise.resolve('unavailable')),
      },
      permissionPresets: { registerAuto: () => () => undefined },
      workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
      ...(options.credentials === undefined
        ? {}
        : { credentials: options.credentials }),
    },
    { on: capture.on },
  );
  admitSession(session);
  const started = apply(
    ctx,
    baseConfig(options.decisionReviewer === true ? 'decision' : 'chat'),
  );
  const push = (config: unknown): void => {
    apply(ctx, config);
  };
  return {
    host: started,
    gate: capture.gate(),
    session,
    applyConfig: push,
  };
}

function baseConfig(
  reviewerType: 'chat' | 'decision' = 'chat',
): Record<string, unknown> {
  return {
    format: 'arbiter-config-v2',
    rules: [
      {
        id: 'no-rm',
        comment: 'Block recursive delete',
        conditions: [{ target: 'command', kind: 'regex', pattern: '^rm .*' }],
        verdict: 'deny',
      },
      {
        id: 'ask-sudo',
        comment: 'Ask before sudo',
        conditions: [{ target: 'command', kind: 'regex', pattern: '^sudo .*' }],
        verdict: 'force-ask',
      },
    ],
    modes: { main: 'ask', subagent: 'no-ask' },
    reviewer:
      reviewerType === 'decision'
        ? {
            type: 'decision',
            decision: {
              url: 'https://reviewer.invalid/decide',
              model: 'clef-flash',
              apiKeyRef: 'MISSING_TOKEN',
              timeoutMs: 2_000,
              costTier: 'paid',
            },
          }
        : {
            type: 'chat',
            chat: {
              provider: 'session',
              model: '',
              temperature: 0,
              maxTokens: 400,
              timeoutMs: 8_000,
              maxRepairRetries: 1,
            },
          },
    audit: { enabled: true, retentionDays: 30 },
  };
}

function call(
  session: StubSession,
  callId: string,
  command: string,
): Parameters<Gate>[0] {
  return {
    callId,
    name: 'bash',
    arguments: { command },
    signal: new AbortController().signal,
    agent: { session },
  };
}

const allowNext = (): Promise<{ kind: string }> =>
  Promise.resolve({ kind: 'allow' });

/** Run one call through the registered gate. */
async function run(
  harness: Harness,
  callId: string,
  command: string,
): Promise<string> {
  const decision = await harness.gate(
    call(harness.session, callId, command),
    allowNext,
  );
  return decision.kind;
}

function fieldsOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new TypeError('expected an object');
  return { ...value };
}

function fieldOf(value: unknown, name: string): unknown {
  return Reflect.get(fieldsOf(value), name);
}

function stringField(value: unknown, name: string): string {
  const field = fieldOf(value, name);
  if (typeof field !== 'string')
    throw new TypeError(`${name} must be a string`);
  return field;
}

function boolField(value: unknown, name: string): boolean {
  const field = fieldOf(value, name);
  if (typeof field !== 'boolean')
    throw new TypeError(`${name} must be a boolean`);
  return field;
}

function listField(value: unknown, name: string): readonly unknown[] {
  const field = fieldOf(value, name);
  if (!Array.isArray(field)) throw new TypeError(`${name} must be a list`);
  return field as readonly unknown[];
}

/** The decoded JSON body of a detail request. */
async function detailBody(
  host: HostEnvironment,
  callId: string,
): Promise<{
  readonly status: number;
  readonly body: unknown;
}> {
  const response = await logRoute(host).fetch(
    new Request(
      `http://fixture/api/arbiter/log?callId=${encodeURIComponent(callId)}`,
    ),
  );
  const body: unknown = JSON.parse(await response.text());
  return { status: response.status, body };
}

/** The detail payload, asserting the read succeeded. */
async function detailOf(
  host: HostEnvironment,
  callId: string,
): Promise<unknown> {
  const read = await detailBody(host, callId);
  if (read.status !== 200)
    throw new Error(`the detail read failed: ${JSON.stringify(read.body)}`);
  expect(read.status).toBe(200);
  expect(fieldOf(read.body, 'ok')).toBe(true);
  return fieldOf(read.body, 'detail');
}

/** Wait until the audit row for this call exists. */
async function persisted(host: HostEnvironment, callId: string): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const read = host.currentAudit()?.readCall(callId);
    if (read !== undefined && read.record !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`the audit row for ${callId} never appeared`);
}

function auditPath(): string {
  return join(process.env['DSH_HOME'] ?? '', 'arbiter', 'arbiter.db');
}

const missingOf = (detail: unknown): readonly string[] =>
  listField(detail, 'missing').filter(
    (code): code is string => typeof code === 'string',
  );

describe('full audit detail', () => {
  test('projects the stored chain, the historical rule name and the execution result', async () => {
    const harness = startHarness();
    expect(await run(harness, 'rule-denied', 'rm -rf build')).toBe('deny');
    await persisted(harness.host, 'rule-denied');

    // The rule is renamed afterwards; the detail must still show the name the
    // row recorded, not the configuration in effect now.
    harness.applyConfig({
      ...baseConfig(),
      rules: [
        {
          id: 'no-rm',
          comment: 'Renamed after the fact',
          conditions: [{ target: 'command', kind: 'regex', pattern: '^rm .*' }],
          verdict: 'deny',
        },
      ],
    });

    const detail = await detailOf(harness.host, 'rule-denied');
    expect(fieldOf(detail, 'source')).toBe('audit');
    const overview = fieldOf(detail, 'overview');
    expect(stringField(overview, 'verdict')).toBe('deny');
    expect(stringField(overview, 'tool')).toBe('bash');
    expect(stringField(overview, 'approvalMode')).toBe('ask');
    expect(fieldOf(overview, 'cancelled')).toBe(false);

    const basis = fieldOf(detail, 'basis');
    expect(fieldOf(basis, 'rule')).toEqual({
      ruleId: 'no-rm',
      ruleName: 'Block recursive delete',
    });
    const chain = listField(basis, 'chain');
    expect(chain).toHaveLength(1);
    expect(fieldOf(chain[0], 'stage')).toBe('rule');
    expect(fieldOf(chain[0], 'ruleName')).toBe('Block recursive delete');
    // A rule short-circuit never asked the model: no snapshot, no attempt, and
    // the detail says so rather than fabricating a review.
    expect(fieldOf(basis, 'evidence')).toEqual([]);
    expect(listField(fieldOf(detail, 'raw'), 'modelAttempts')).toEqual([]);
    const missing = missingOf(detail);
    // A rule short-circuit never asked the model, so no snapshot or attempt is
    // reported as missing; the basis says the call was not reviewed instead.
    expect(missing).not.toContain('snapshot-missing');
    expect(missing).not.toContain('model-attempts-missing');
    expect(fieldOf(basis, 'reviewState')).toBe('none');
    // A denied call never started, so its execution result is not a gap.
    expect(fieldOf(overview, 'execution')).toEqual({
      status: 'not-started',
      startedAt: null,
      finishedAt: null,
    });
    expect(missing).not.toContain('execution-not-observed');
  });

  test('keeps the permission verdict apart from a later execution result', async () => {
    const harness = startHarness();
    expect(await run(harness, 'reviewed', 'echo hi')).toBe('allow');
    await persisted(harness.host, 'reviewed');

    const before = await detailOf(harness.host, 'reviewed');
    expect(stringField(fieldOf(before, 'overview'), 'verdict')).toBe(
      'review-allow',
    );
    expect(fieldOf(fieldOf(before, 'overview'), 'execution')).toEqual({
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    });
    expect(missingOf(before)).toContain('execution-not-observed');

    harness.host
      .currentAudit()
      ?.updateExecution('reviewed', 'success', 1_700_000_000_000);
    const after = await detailOf(harness.host, 'reviewed');
    // The execution result changed; the permission verdict did not.
    expect(stringField(fieldOf(after, 'overview'), 'verdict')).toBe(
      'review-allow',
    );
    expect(fieldOf(fieldOf(after, 'overview'), 'execution')).toEqual({
      status: 'success',
      startedAt: null,
      finishedAt: 1_700_000_000_000,
    });
    expect(missingOf(after)).not.toContain('execution-not-observed');
  });

  test('shows every attempt and preserves original tool arguments', async () => {
    const harness = startHarness();
    const audit = harness.host.currentAudit();
    if (audit === null) throw new Error('the audit store did not start');
    const record: CallRecord = {
      callId: 'with-attempt',
      ts: Date.now(),
      sessionId: harness.session.id,
      sessionKind: 'main',
      parentSession: null,
      profile: 'detail',
      workspace: process.cwd(),
      tool: 'bash',
      arguments: {
        command:
          'curl -H "Authorization: Bearer top-secret" https://example.test',
      },
      cwd: process.cwd(),
      fingerprint: 'bash:attempt',
      configRevision: 'rev-1',
      configSnapshotId: 'cfg-1',
      approvalMode: 'ask',
      executionMode: 'guarded',
      result: 'review-deny',
      reason: 'the review denied this call',
      trace: [
        { stage: 'rule', result: 'review(default)', at: 1 },
        { stage: 'review', result: 'review-deny', at: 2 },
      ],
      effect: null,
      sessionRecordState: 'written',
      snapshot: null,
      modelAttempts: [
        {
          requestId: 'with-attempt:model:1',
          callId: 'with-attempt',
          attempt: 1,
          backend: 'decision',
          protocol: 'arbiter-decision-v1',
          request: {
            model: 'clef-flash',
            headers: { authorization: 'Bearer top-secret' },
            state: 'Authorization: Bearer top-secret',
          },
          responseText: 'echoed Authorization: Bearer top-secret',
          parsed: { risk: 5 },
          error: null,
          startedAt: 1,
          durationMs: 2,
          estimatedInputTokens: 3,
          usage: null,
          normalizedUsage: null,
        },
      ],
      scores: null,
      reviewStage: null,
      usage: null,
      decisionRules: ['R7'],
      executionStatus: 'not-started',
    };
    audit.enqueue(record);
    await persisted(harness.host, 'with-attempt');

    const detail = await detailOf(harness.host, 'with-attempt');
    // The user's own command is original evidence and is shown as stored: a
    // value inside a tool argument is not a Reviewer transport credential.
    const argumentsValue = JSON.stringify(
      fieldOf(fieldOf(detail, 'raw'), 'arguments'),
    );
    expect(argumentsValue).toContain('top-secret');
    const attempts = listField(fieldOf(detail, 'raw'), 'modelAttempts');
    // The transport block is removed; the reviewed content is not rewritten.
    const request = fieldOf(attempts[0], 'request');
    expect(JSON.stringify(fieldOf(request, 'headers'))).not.toContain(
      'top-secret',
    );
    expect(JSON.stringify(fieldOf(request, 'state'))).toContain('top-secret');
    expect(attempts).toHaveLength(1);
    // The model's own answer text is still shown, with only the credential masked.
    expect(stringField(attempts[0], 'responseText')).toContain('echoed');
    expect(fieldOf(attempts[0], 'parsed')).toEqual({ risk: 5 });
  });
});

describe('degraded sources', () => {
  test('falls back to the session record after the audit rows are cleared', async () => {
    const harness = startHarness();
    expect(await run(harness, 'cleared', 'echo hi')).toBe('allow');
    await persisted(harness.host, 'cleared');
    const cleared = harness.host.currentAudit()?.clearCalls();
    expect(cleared).toEqual({ ok: true, deleted: 1 });

    // The audit row is gone. This call's verdict is still in the runtime window
    // or the committed decision record; either way the source is the session,
    // and the view names the audit gap instead of showing empty layers.
    const detail = await detailOf(harness.host, 'cleared');
    expect(fieldOf(detail, 'source')).toBe('session');
    expect(stringField(fieldOf(detail, 'overview'), 'verdict')).toBe(
      'review-allow',
    );
    const missing = missingOf(detail);
    expect(missing).toContain('audit-record-cleared');
    // The record proves a review happened, so its absent snapshot and attempts
    // are real gaps rather than "not applicable".
    expect(missing).toContain('snapshot-missing');
    expect(missing).toContain('model-attempts-missing');
    // The minimal record has no execution observation, and none is invented.
    expect(fieldOf(fieldOf(detail, 'overview'), 'execution')).toEqual({
      status: null,
      startedAt: null,
      finishedAt: null,
    });
  });

  test('reads the committed decision record when memory is gone, without the live rule name', async () => {
    const harness = startHarness();
    expect(await run(harness, 'log-only', 'rm -rf build')).toBe('deny');
    await persisted(harness.host, 'log-only');
    harness.host.currentAudit()?.clearCalls();
    // Simulate a runtime whose window no longer holds this entry, as a restart
    // would leave it: only the committed session record remains.
    harness.host.runtime.priorVerdicts.clear();

    const detail = await detailOf(harness.host, 'log-only');
    expect(fieldOf(detail, 'source')).toBe('session');
    const overview = fieldOf(detail, 'overview');
    expect(stringField(overview, 'verdict')).toBe('deny');
    expect(stringField(overview, 'sessionId')).toBe(harness.session.id);
    const basis = fieldOf(detail, 'basis');
    // The session record keeps result strings, not stage names or rule names.
    expect(fieldOf(basis, 'chain')).toBeNull();
    expect(listField(basis, 'trace')).toEqual(['deny']);
    expect(fieldOf(basis, 'rule')).toEqual({ ruleId: 'no-rm', ruleName: null });
    const missing = missingOf(detail);
    expect(missing).toContain('stage-details-missing');
    expect(missing).toContain('rule-name-missing');
    // The rule is still named "Block recursive delete" in the live config; the
    // detail must not borrow it to explain a record that did not store it.
    const serialized = JSON.stringify(detail);
    expect(serialized).not.toContain('Block recursive delete');
  });

  test('reports audit disabled while still explaining the call from memory', async () => {
    const harness = startHarness();
    expect(await run(harness, 'disabled-audit', 'rm -rf build')).toBe('deny');
    await persisted(harness.host, 'disabled-audit');
    harness.applyConfig({
      ...baseConfig(),
      audit: { enabled: false },
    });

    const detail = await detailOf(harness.host, 'disabled-audit');
    expect(fieldOf(detail, 'source')).toBe('session');
    expect(missingOf(detail)).toContain('audit-disabled');
  });

  test('answers that every source is missing for an unknown call', async () => {
    const harness = startHarness();
    const read = await detailBody(harness.host, 'never-happened');
    expect(read.status).toBe(404);
    expect(read.body).toEqual({ ok: false, code: 'record-unavailable' });
  });
});

describe('conflicting and partial evidence', () => {
  test('surfaces two conflicting session observations instead of one verdict', async () => {
    const harness = startHarness();
    expect(await run(harness, 'disputed', 'rm -rf build')).toBe('deny');
    await persisted(harness.host, 'disputed');
    harness.host.currentAudit()?.clearCalls();
    harness.host.runtime.priorVerdicts.clear();
    // A second, contradicting observation of the same logical call, written the
    // way a different settlement of the same call id would write it.
    harness.session.append('plugin:arbiter/decision', {
      version: 2,
      callId: 'disputed',
      tool: 'bash',
      fingerprint: 'bash:disputed',
      trace: ['review(default)', 'human-allow'],
      result: 'human-allow',
      reason: 'a human later allowed it',
      ruleId: null,
      decisionRules: [],
      configRevision: 'rev-2',
      ts: Date.now(),
    });

    const detail = await detailOf(harness.host, 'disputed');
    const basis = fieldOf(detail, 'basis');
    const conflicts = listField(basis, 'conflicts');
    expect(conflicts.length).toBeGreaterThan(0);
    const result = conflicts.find(
      (conflict) => fieldOf(conflict, 'field') === 'result',
    );
    if (result === undefined)
      throw new Error('no result conflict was reported');
    expect(listField(result, 'observed')).toEqual(
      expect.arrayContaining(['deny', 'human-allow']),
    );
    // Both readings survive; the visible verdict is not the only stored fact.
    expect(JSON.stringify(detail).includes('a human later allowed it')).toBe(
      true,
    );
  });

  test('a reviewed call whose audit row is cleared says the material is lost', async () => {
    const harness = startHarness();
    expect(await run(harness, 'reviewed-then-cleared', 'echo hi')).toBe(
      'allow',
    );
    await persisted(harness.host, 'reviewed-then-cleared');
    harness.host.currentAudit()?.clearCalls();

    const detail = await detailOf(harness.host, 'reviewed-then-cleared');
    const basis = fieldOf(detail, 'basis');
    // The stored chain proves a review happened, so the absent snapshot and
    // attempts are reported as gaps rather than as "no review".
    expect(fieldOf(basis, 'reviewState')).toBe('reviewed');
    const missing = missingOf(detail);
    expect(missing).toContain('snapshot-missing');
    expect(missing).toContain('model-attempts-missing');
  });

  test('a stored attempt is positive evidence even with an empty trace', async () => {
    const harness = startHarness();
    const audit = harness.host.currentAudit();
    if (audit === null) throw new Error('the audit store did not start');
    // A readable v1-style row whose result list was never written but whose
    // attempt rows exist: the attempt is the record that a request went out.
    audit.enqueue({
      callId: 'attempt-no-trace',
      ts: Date.now(),
      sessionId: harness.session.id,
      sessionKind: 'main',
      parentSession: null,
      profile: 'detail',
      workspace: process.cwd(),
      tool: 'bash',
      arguments: { command: 'echo hi' },
      cwd: process.cwd(),
      fingerprint: 'bash:empty-trace',
      configRevision: 'rev-1',
      configSnapshotId: 'cfg-1',
      approvalMode: 'ask',
      executionMode: 'guarded',
      result: 'fallback-deny',
      reason: 'the review failed',
      trace: [],
      effect: null,
      sessionRecordState: 'written',
      snapshot: null,
      modelAttempts: [
        {
          requestId: 'attempt-no-trace:model:1',
          callId: 'attempt-no-trace',
          attempt: 1,
          backend: 'decision',
          protocol: 'arbiter-decision-v1',
          request: { model: 'clef-flash' },
          responseText: null,
          parsed: null,
          error: 'backend unreachable',
          startedAt: 1,
          durationMs: 2,
          estimatedInputTokens: 3,
          usage: null,
          normalizedUsage: null,
        },
      ],
      scores: null,
      reviewStage: null,
      usage: null,
      decisionRules: [],
      executionStatus: 'not-started',
    });
    await persisted(harness.host, 'attempt-no-trace');

    const detail = await detailOf(harness.host, 'attempt-no-trace');
    const basis = fieldOf(detail, 'basis');
    expect(listField(basis, 'trace')).toEqual([]);
    // The stored attempt proves a request, so the state is not "unknown".
    expect(fieldOf(basis, 'reviewState')).toBe('reviewed');
    expect(listField(fieldOf(detail, 'raw'), 'modelAttempts')).toHaveLength(1);
    expect(missingOf(detail)).toContain('snapshot-missing');
  });

  test('a referenced template with no row is reported missing', async () => {
    const harness = startHarness();
    const audit = harness.host.currentAudit();
    if (audit === null) throw new Error('the audit store did not start');
    audit.enqueue({
      callId: 'dangling-template',
      ts: Date.now(),
      sessionId: harness.session.id,
      sessionKind: 'main',
      parentSession: null,
      profile: 'detail',
      workspace: process.cwd(),
      tool: 'bash',
      arguments: { command: 'echo hi' },
      cwd: process.cwd(),
      fingerprint: 'bash:tpl',
      configRevision: 'rev-1',
      configSnapshotId: 'cfg-1',
      approvalMode: 'ask',
      executionMode: 'guarded',
      result: 'review-deny',
      reason: 'denied',
      trace: [
        { stage: 'rule', result: 'review(default)', at: 1 },
        { stage: 'review', result: 'review-deny', at: 2 },
      ],
      effect: null,
      sessionRecordState: 'written',
      snapshot: null,
      modelAttempts: [
        {
          requestId: 'dangling-template:model:1',
          callId: 'dangling-template',
          attempt: 1,
          backend: 'chat',
          protocol: 'arbiter-chat-json-v1',
          // A template id the templates table does not contain: `model_calls`
          // declares no foreign key, so this state is representable.
          templateId: 'tpl-absent',
          request: { system: 'review this' },
          responseText: '{"risk":9}',
          parsed: { risk: 9 },
          error: null,
          startedAt: 1,
          durationMs: 2,
          estimatedInputTokens: 3,
          usage: null,
          normalizedUsage: null,
        },
      ],
      scores: null,
      reviewStage: null,
      usage: null,
      decisionRules: [],
      executionStatus: 'not-started',
    });
    await persisted(harness.host, 'dangling-template');

    const detail = await detailOf(harness.host, 'dangling-template');
    expect(missingOf(detail)).toContain('template-missing');
    const templates = listField(fieldOf(detail, 'raw'), 'templates');
    expect(templates).toHaveLength(1);
    // It is reported as an absent row, not as a template with empty content.
    expect(fieldOf(templates[0], 'present')).toBe(false);
    expect(fieldOf(templates[0], 'content')).toBeNull();
  });
});

describe('pre-request review failures', () => {
  test('an open circuit breaker reports no model request rather than a lost one', async () => {
    const harness = startHarness({
      // The channel is unavailable, so a breaker exit settles as a fallback
      // without ever calling the model.
      approval: () => Promise.resolve('unavailable'),
    });
    // Open the breaker through the real gate: three consecutive rule denials
    // trip the balanced preset. A rule denial short-circuits before the review,
    // so it never asks the model itself.
    for (let index = 0; index < 3; index += 1) {
      expect(await run(harness, `trip-${String(index)}`, 'rm -rf build')).toBe(
        'deny',
      );
    }
    expect(await run(harness, 'breaker-open', 'echo breaker')).not.toBe(
      'allow',
    );
    await persisted(harness.host, 'breaker-open');

    const detail = await detailOf(harness.host, 'breaker-open');
    const basis = fieldOf(detail, 'basis');
    const chain = listField(basis, 'chain');
    const results = chain.map((stage) => fieldOf(stage, 'result'));
    // The chain really did enter the review pipeline and fail before requesting.
    expect(results).toContain('error-escalate');
    expect(
      chain.some((stage) => fieldOf(stage, 'reason') === 'circuit_open'),
    ).toBe(true);

    // No model request was made, so nothing is reported as lost material.
    expect(fieldOf(basis, 'reviewState')).toBe('none');
    const missing = missingOf(detail);
    expect(missing).not.toContain('snapshot-missing');
    expect(missing).not.toContain('model-attempts-missing');
    expect(listField(fieldOf(detail, 'raw'), 'modelAttempts')).toEqual([]);
  });

  test('a Reviewer that fails before calling out does not report lost attempts', async () => {
    // A decision Reviewer with a credential reference nothing resolves: the
    // adapter fails before any fetch, so no attempt record is produced at all.
    const harness = startHarness({
      approval: () => Promise.resolve('unavailable'),
      decisionReviewer: true,
      credentials: { resolve: () => Promise.resolve(undefined) },
    });
    expect(await run(harness, 'no-credential', 'echo needs-review')).not.toBe(
      'allow',
    );
    await persisted(harness.host, 'no-credential');

    const detail = await detailOf(harness.host, 'no-credential');
    const basis = fieldOf(detail, 'basis');
    const chain = listField(basis, 'chain');
    const escalation = chain.find(
      (stage) => fieldOf(stage, 'result') === 'error-escalate',
    );
    if (escalation === undefined)
      throw new Error('the review failure was not recorded');
    // The adapter failed before the request; the record proves no attempt.
    expect(listField(fieldOf(detail, 'raw'), 'modelAttempts')).toEqual([]);
    expect(fieldOf(basis, 'reviewState')).toBe('unknown');
    expect(missingOf(detail)).not.toContain('model-attempts-missing');
    expect(missingOf(detail)).not.toContain('snapshot-missing');
  });

  test('a real failed attempt is unknown, not "no request", after audit cleanup', async () => {
    // A transport failure really did issue one request, so the row stores one
    // failed attempt. Afterwards the audit row is gone and only the session
    // record — result strings without reasons or attempts — remains.
    const harness = startHarness({
      decisionReviewer: true,
      approval: () => Promise.resolve('unavailable'),
      credentials: { resolve: () => Promise.resolve({ value: 'token-1' }) },
    });
    // The adapter uses the host's own fetch; making it reject is exactly the
    // transport failure that still records one attempt.
    const realFetch = globalThis.fetch;
    globalThis.fetch = () => Promise.reject(new Error('backend unreachable'));
    try {
      expect(
        await run(harness, 'transport-failed', 'echo needs-review'),
      ).not.toBe('allow');
    } finally {
      globalThis.fetch = realFetch;
    }
    await persisted(harness.host, 'transport-failed');
    const audited = await detailOf(harness.host, 'transport-failed');
    // With the audit row present, the recorded failed attempt is proof.
    expect(listField(fieldOf(audited, 'raw'), 'modelAttempts')).toHaveLength(1);
    expect(fieldOf(fieldOf(audited, 'basis'), 'reviewState')).toBe('reviewed');

    harness.host.currentAudit()?.clearCalls();
    harness.host.runtime.priorVerdicts.clear();
    const detail = await detailOf(harness.host, 'transport-failed');
    // The session record cannot tell a request from a routing-only entry, so the
    // answer is "cannot establish", not "no request was issued".
    expect(fieldOf(fieldOf(detail, 'basis'), 'reviewState')).toBe('unknown');
  });

  test('a human-allow reached without a review does not claim a model request', async () => {
    const harness = startHarness({
      approval: () => Promise.resolve('allowed-once'),
    });
    expect(await run(harness, 'human-only', 'sudo ls')).toBe('allow');
    await persisted(harness.host, 'human-only');

    const detail = await detailOf(harness.host, 'human-only');
    const basis = fieldOf(detail, 'basis');
    const results = listField(basis, 'chain').map((stage) =>
      fieldOf(stage, 'result'),
    );
    // `force-ask` went straight to the human: no review stage, no request.
    expect(results).toContain('human-allow');
    expect(results.some((result) => String(result).startsWith('review-'))).toBe(
      false,
    );
    expect(fieldOf(basis, 'reviewState')).toBe('none');
    expect(missingOf(detail)).not.toContain('model-attempts-missing');
  });
});

describe('old records and endings', () => {
  test('a v1 row is shown with its absent columns unknown, not defaulted', async () => {
    const harness = startHarness();
    harness.host.currentAudit()?.close();
    const db = new DatabaseSync(auditPath());
    db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
         execution_mode, result, reason, trace, effect, session_record_state, signals,
         policy_strategy, decision_rules, execution_status, record_format_version,
         execution_started_at, execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy-detail',
      Date.now(),
      harness.session.id,
      'main',
      null,
      'detail',
      process.cwd(),
      'bash',
      '{"command":"echo hi"}',
      process.cwd(),
      'bash:legacy',
      'rev-old',
      'cfg-old',
      'normal',
      'guarded',
      'review-deny',
      'legacy row',
      '[]',
      'null',
      'written',
      null,
      null,
      '[]',
      'pending',
      1,
      null,
      null,
    );
    db.close();
    harness.host.runtime.audit = null;
    harness.host.runtime.config = {
      ...harness.host.runtime.config,
      audit: { ...harness.host.runtime.config.audit, enabled: true },
    };

    const detail = await detailOf(harness.host, 'legacy-detail');
    expect(fieldOf(detail, 'recordFormatVersion')).toBe(1);
    const overview = fieldOf(detail, 'overview');
    expect(stringField(overview, 'verdict')).toBe('review-deny');
    expect(fieldOf(overview, 'execution')).toEqual({
      status: 'pending',
      startedAt: null,
      finishedAt: null,
    });
    const basis = fieldOf(detail, 'basis');
    expect(fieldOf(basis, 'chain')).toBeNull();
    expect(fieldOf(basis, 'signals')).toBeNull();
    expect(fieldOf(basis, 'policyStrategy')).toBeNull();
    const raw = fieldOf(detail, 'raw');
    expect(fieldOf(raw, 'snapshot')).toBeNull();
    expect(fieldOf(raw, 'config')).toBeNull();
    // A v1 row has no stage rows and no snapshot column, so whether a review
    // happened is unknown: the view names that rather than claiming a snapshot
    // went missing. The named configuration snapshot has no row, which is a
    // real gap.
    const missing = missingOf(detail);
    expect(missing).toContain('stages-missing');
    expect(missing).toContain('config-missing');
    expect(fieldOf(basis, 'reviewState')).toBe('unknown');
  });

  test('a record written by a newer plugin is reported, not reinterpreted', async () => {
    const harness = startHarness();
    harness.host.currentAudit()?.close();
    const db = new DatabaseSync(auditPath());
    db.prepare(
      `INSERT INTO calls(call_id, ts, session_id, session_kind, parent_session, profile, workspace,
         tool, arguments, cwd, fingerprint, config_revision, config_snapshot_id, approval_mode,
         execution_mode, result, reason, trace, effect, session_record_state, signals,
         policy_strategy, decision_rules, execution_status, record_format_version,
         execution_started_at, execution_finished_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'future-detail',
      Date.now(),
      harness.session.id,
      'main',
      null,
      'detail',
      process.cwd(),
      'bash',
      '{"command":"echo hi"}',
      process.cwd(),
      'bash:future',
      'rev-f',
      'cfg-f',
      'normal',
      'guarded',
      'review-allow',
      'future row',
      '[]',
      'null',
      'written',
      null,
      null,
      '[]',
      'success',
      99,
      null,
      null,
    );
    db.close();
    harness.host.runtime.audit = null;

    const detail = await detailOf(harness.host, 'future-detail');
    expect(boolField(detail, 'unreadable')).toBe(true);
    expect(fieldOf(detail, 'recordFormatVersion')).toBe(99);
    expect(stringField(detail, 'unreadableReason')).toContain('newer');
    // The verdict is not read from a shape this build cannot interpret.
    expect(fieldOf(fieldOf(detail, 'overview'), 'verdict')).toBeNull();
    expect(missingOf(detail)).toEqual(['record-format-newer']);
  });

  test('a cancelled approval is reported as cancelled, not as a denial', async () => {
    const harness = startHarness({
      approval: () => Promise.resolve('cancelled'),
    });
    // A cancelled approval refuses the call, so the gate answer is a denial;
    // the record must still distinguish "withdrawn" from "denied".
    expect(await run(harness, 'cancelled-call', 'sudo ls')).toBe('deny');
    await persisted(harness.host, 'cancelled-call');

    const detail = await detailOf(harness.host, 'cancelled-call');
    const overview = fieldOf(detail, 'overview');
    expect(stringField(overview, 'verdict')).toBe('human-abort');
    expect(fieldOf(overview, 'cancelled')).toBe(true);
    const chain = listField(fieldOf(detail, 'basis'), 'chain');
    expect(chain.map((stage) => fieldOf(stage, 'result'))).toContain(
      'human-abort',
    );
  });
});
