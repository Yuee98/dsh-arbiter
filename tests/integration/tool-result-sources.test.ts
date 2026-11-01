import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { unlinkSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildSync } from 'esbuild';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  prepareReviewSnapshot,
  type SnapshotOptions,
} from '../../src/snapshot.js';
import { captureSnapshotSources } from '../../src/snapshot/sources.js';
import * as guidance from '../../src/snapshot/guidance.js';
import { CredentialRedactor } from '../../src/reviewer/credential-redactor.js';
import { discoverLog } from '../../src/snapshot/source-redaction.js';
import { RESULT_REFERENCE } from '../../src/snapshot/tool-result-reference.js';
import { installSessionRecordApi } from '../../src/records.js';
import { recordingSessionApi } from '../helpers/session-records.js';
import {
  observerFixture,
  observationSession,
} from './result-observer-fixture.js';

let fixture: ReturnType<typeof observerFixture>;
beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});
afterAll(() => {
  installSessionRecordApi(null);
});
beforeEach(() => {
  fixture = observerFixture();
});
afterEach(() => {
  vi.restoreAllMocks();
  fixture.close();
});
function options(overrides: Partial<SnapshotOptions> = {}): SnapshotOptions {
  return {
    agent: { session: fixture.session },
    tool: 'bash',
    arguments: { command: 'echo pending' },
    callId: 'pending',
    cwd: fixture.root,
    config: DEFAULT_CONFIG,
    facts: null,
    priorVerdicts: [],
    sessionRecordGap: null,
    configRevision: 'source-test',
    toolResults: fixture.reader,
    ...overrides,
  };
}
function observe(callId: string, text: string, ptc = false) {
  const exec = fixture.exec(callId);
  fixture.session.append(
    ptc ? 'tool/ptc-dispatch-start' : 'tool/call',
    ptc
      ? {
          subCallId: callId,
          rootCallId: 'outer',
          name: 'bash',
          arguments: exec.arguments,
        }
      : { callId, name: exec.name, arguments: exec.arguments },
  );
  fixture.observer.begin(exec);
  fixture.observer.observe(exec, {
    isError: false,
    content: [{ type: 'text', text }],
  });
  fixture.session.append(
    ptc ? 'tool/ptc-dispatch' : 'tool/result',
    ptc
      ? {
          subCallId: callId,
          rootCallId: 'outer',
          isError: false,
          content: [{ type: 'text', text }],
        }
      : {
          message: {
            source: { kind: 'tool', callId },
            isError: false,
            content: [{ type: 'text', text }],
          },
        },
  );
}
function sourceEvents(
  source: Awaited<ReturnType<typeof captureSnapshotSources>>,
) {
  if (source.eventSources === undefined)
    throw new Error('missing captured events');
  return source.eventSources.local.events;
}

describe('receipt-bound historical result sources', () => {
  test.each([false, true])(
    'preserves small reference at its actual observation position (PTC %s)',
    async (ptc) => {
      observe('query', 'visible-listing', ptc);
      const reference = fixture.session.events.find(
        (event) => event.type === RESULT_REFERENCE,
      );
      const source = await captureSnapshotSources(options());
      const result = sourceEvents(source).filter(
        (event) => event.kind === 'result' && event.body.state === 'present',
      );
      expect(result).toHaveLength(1);
      expect(result[0]?.seq).toBe(reference?.seq);
      expect(JSON.stringify(result)).toContain('visible-listing');
      expect(
        sourceEvents(source).some(
          (event) => event.kind === 'call' && event.callId === 'query',
        ),
      ).toBe(true);
    },
  );
  test(
    'B01: two actual 12MiB native bodies cannot hide their persisted 1MiB fragments',
    { timeout: 30_000 },
    async () => {
      const text = 'x'.repeat(12 * 1024 * 1024);
      observe('A', text);
      observe('B', text);
      const originals = fixture.session.events.filter(
        (event) => event.type === 'tool/result',
      );
      const source = await captureSnapshotSources(options());
      const results = sourceEvents(source).filter(
        (event) => event.kind === 'result' && event.body.state === 'present',
      );
      expect(results).toHaveLength(2);
      expect(source.eventSources?.local.status.status).toBe('complete');
      for (const callId of ['A', 'B'])
        expect(
          fixture.audit.getToolResult('session', callId).metadata
            ?.retainedBytes,
        ).toBe(1_048_576);
      expect(JSON.stringify(source.log).length).toBeLessThan(10_000);
      expect(JSON.stringify(originals).length).toBeGreaterThan(
        24 * 1024 * 1024,
      );
      expect(JSON.stringify(results)).toContain('separate retained ranges');
    },
  );
  test('B02: null/failed/unverified receipts never key-read a later repair', async () => {
    for (const [index, save] of [
      'failed',
      'already-recorded',
      'saved',
    ].entries())
      fixture.session.append(RESULT_REFERENCE, {
        version: 1,
        sessionId: 'session',
        callId: `old-${String(index)}`,
        tool: 'bash',
        status: 'success',
        contentState: 'available',
        save,
        receipt: null,
      });
    for (let index = 0; index < 3; index += 1)
      fixture.audit.saveToolResult({
        sessionId: 'session',
        callId: `old-${String(index)}`,
        observedAt: Date.now(),
        status: 'success',
        contentState: 'available',
        parts: [{ kind: 'text', channel: 'content', text: 'future-repair' }],
      });
    const read = vi.fn(fixture.reader.read);
    const source = await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(sourceEvents(source))).not.toContain('future-repair');
  });
  test('B02: old failed receipt remains header-only after actual first-final repair', async () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const failed = fixture.audit.saveToolResult({
      sessionId: 'session',
      callId: 'repair',
      observedAt: Date.now(),
      status: 'success',
      contentState: 'available',
      parts: [{ kind: 'json', channel: 'value', value: cycle }],
    });
    expect(failed.state).toBe('failed');
    fixture.session.append(RESULT_REFERENCE, {
      version: 1,
      sessionId: 'session',
      callId: 'repair',
      tool: 'bash',
      status: 'success',
      contentState: 'available',
      save: 'failed',
      receipt: failed.receipt,
    });
    const repaired = fixture.audit.saveToolResult({
      sessionId: 'session',
      callId: 'repair',
      observedAt: Date.now(),
      status: 'success',
      contentState: 'available',
      parts: [{ kind: 'text', channel: 'content', text: 'repaired-later' }],
    });
    expect(repaired.state).toBe('saved');
    expect(repaired.receipt).not.toEqual(failed.receipt);
    const read = vi.fn(fixture.reader.read);
    const old = await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(JSON.stringify(old)).not.toContain('repaired-later');
    fixture.session.append(RESULT_REFERENCE, {
      version: 1,
      sessionId: 'session',
      callId: 'repair',
      tool: 'bash',
      status: 'success',
      contentState: 'available',
      save: 'saved',
      receipt: repaired.receipt,
    });
    const current = await captureSnapshotSources(options());
    expect(JSON.stringify(current)).toContain('repaired-later');
  });
  test('late results affect only a new capture; pending PTC and parent tools cause no body reads', async () => {
    observe('before', 'before-body');
    fixture.session.append('tool/ptc-dispatch-start', {
      subCallId: 'pending',
      name: 'bash',
      arguments: {},
    });
    observe('after', 'future-body', true);
    const read = vi.fn(fixture.reader.read);
    const source = await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(source)).not.toContain('future-body');
    const parent = observationSession('parent');
    parent.events.push(...fixture.session.events);
    const child = observationSession('child', 'parent');
    child.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'child-human' }],
    });
    read.mockClear();
    await captureSnapshotSources(
      options({
        agent: { session: child },
        sessions: { get: (id) => (id === 'parent' ? parent : child) },
        toolResults: { ...fixture.reader, read },
      }),
    );
    expect(read).not.toHaveBeenCalled();
    const later = await captureSnapshotSources(
      options({ callId: 'new-pending' }),
    );
    expect(JSON.stringify(later)).toContain('future-body');
    expect(JSON.stringify(source)).not.toContain('future-body');
  });
  test('saved reference with a cleared body preserves cleared; owner/receipt mismatch cannot borrow another row', async () => {
    observe('clear', 'cleared-body');
    fixture.audit.clearCalls();
    const cleared = await captureSnapshotSources(options());
    expect(
      sourceEvents(cleared).flatMap((event) =>
        event.kind === 'result' && event.collection !== undefined
          ? [event.collection.read]
          : [],
      ),
    ).toEqual(['cleared']);
    const read = vi.fn(fixture.reader.read);
    fixture.session.append(RESULT_REFERENCE, {
      version: 1,
      sessionId: 'other',
      callId: 'collision',
      tool: 'bash',
      status: 'success',
      contentState: 'available',
      save: 'saved',
      receipt: { sessionId: 'other', callId: 'collision', resultId: 'foreign' },
    });
    fixture.session.append(RESULT_REFERENCE, {
      version: 1,
      sessionId: 'session',
      callId: 'invalid',
      tool: 'bash',
      status: 'success',
      contentState: 'available',
      save: 'saved',
      receipt: { sessionId: 'other', callId: 'invalid', resultId: 'foreign' },
    });
    await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read).toHaveBeenCalledTimes(1);
  });
  test('freezes sources before project await; clear/new result and rebuild never re-read audit', async () => {
    observe('first', 'immutable-first');
    const project = await guidance.readProjectRulesSource(
      fixture.root,
      DEFAULT_CONFIG.context.projectRules,
    );
    let release: ((value: typeof project) => void) | undefined;
    vi.spyOn(guidance, 'readProjectRulesSource').mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const read = vi.fn(fixture.reader.read);
    const pending = prepareReviewSnapshot(
      options({ toolResults: { ...fixture.reader, read } }),
      fixture.workflow,
    );
    expect(read).toHaveBeenCalledTimes(1);
    fixture.audit.clearCalls();
    observe('late', 'future-after-await');
    if (release === undefined) throw new Error('project read not reached');
    release(project);
    const result = await pending;
    const original = JSON.stringify(result.bundle.snapshot);
    expect(result.bundle.user).toContain('immutable-first');
    expect(result.bundle.user).not.toContain('future-after-await');
    result.rebuild(['late-known']);
    expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result.bundle.snapshot)).toBe(original);
  });
  test('missing and corrupt actual stored files retain their distinct source read states', async () => {
    observe('missing', 'm'.repeat(70_000));
    observe('corrupt', 'c'.repeat(70_000));
    const missing = fixture.audit.getToolResult('session', 'missing');
    const corrupt = fixture.audit.getToolResult('session', 'corrupt');
    if (missing.fileRef === null || corrupt.fileRef === null)
      throw new Error('missing actual file storage');
    unlinkSync(join(`${fixture.audit.databasePath}.results`, missing.fileRef));
    writeFileSync(
      join(`${fixture.audit.databasePath}.results`, corrupt.fileRef),
      'corrupt',
    );
    const source = await captureSnapshotSources(options());
    const states = sourceEvents(source).flatMap((event) =>
      event.kind === 'result' && event.collection !== undefined
        ? [[event.callId, event.collection.read]]
        : [],
    );
    expect(states).toContainEqual(['missing', 'missing-file']);
    expect(states).toContainEqual(['corrupt', 'unreadable']);
  });
  test('fetches bodies incrementally under the aggregate source guard and protects latest human', async () => {
    for (let index = 0; index < 20; index += 1)
      observe(`bounded-${String(index)}`, 'x'.repeat(1_048_576));
    fixture.session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: 'latest protected human' }],
    });
    const read = vi.fn(fixture.reader.read);
    const source = await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read.mock.calls.length).toBeGreaterThan(0);
    expect(read.mock.calls.length).toBeLessThan(20);
    expect(source.eventSources?.local.status.status).toBe('stopped');
    expect(
      sourceEvents(source).some(
        (event) =>
          event.kind === 'human' && event.text === 'latest protected human',
      ),
    ).toBe(true);
  });
  test('B03: genuine child save and cold workflow discover raw native credentials before pruning', async () => {
    const entry = join(fixture.root, 'audit-child.cjs');
    buildSync({
      entryPoints: [
        fileURLToPath(new URL('../../src/audit.ts', import.meta.url)),
      ],
      outfile: entry,
      bundle: true,
      platform: 'node',
      format: 'cjs',
      logLevel: 'silent',
    });
    const secret = 'opaque-workflow-secret-42';
    const child = `const {AuditStore}=require(process.argv[1]);const a=new AuditStore(process.argv[2],JSON.parse(process.argv[3]));const s=a.saveToolResult({sessionId:'session',callId:'cold',observedAt:Date.now(),status:'success',contentState:'available',parts:[{kind:'text',channel:'content',text:JSON.stringify({token:process.argv[4]})}]});process.stdout.write(JSON.stringify(s));a.close();`;
    const raw: unknown = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '-e',
          child,
          entry,
          fixture.audit.databasePath,
          JSON.stringify(DEFAULT_CONFIG.audit),
          secret,
        ],
        { encoding: 'utf8' },
      ),
    );
    if (raw === null || typeof raw !== 'object')
      throw new Error('invalid child save');
    const receipt: unknown = Reflect.get(raw, 'receipt');
    expect(Reflect.get(raw, 'state')).toBe('saved');
    expect(fixture.workflow.text(secret)).toBe(secret);
    fixture.session.append('tool/call', {
      callId: 'cold',
      name: 'bash',
      arguments: {},
    });
    fixture.session.append(RESULT_REFERENCE, {
      version: 1,
      sessionId: 'session',
      callId: 'cold',
      tool: 'bash',
      status: 'success',
      contentState: 'available',
      save: 'saved',
      receipt,
    });
    fixture.session.append('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'cold' },
        isError: false,
        content: [{ type: 'text', text: JSON.stringify({ token: secret }) }],
      },
    });
    fixture.session.append('user/message', {
      source: { kind: 'user' },
      content: [{ type: 'text', text: `put ${secret} in ticket` }],
    });
    const cold = await prepareReviewSnapshot(options(), fixture.workflow);
    expect(cold.bundle.user).toContain('in ticket');
    expect(cold.bundle.user).not.toContain(secret);
    const hot = await prepareReviewSnapshot(options(), fixture.workflow);
    expect(hot.bundle.user).not.toContain(secret);
    const newContext = new CredentialRedactor('session');
    discoverLog(
      {
        events: fixture.session.events,
        own: fixture.session.events,
        inherited: 0,
        turnOf: [],
        readable: true,
        error: null,
        attempts: 1,
      },
      newContext,
    );
    expect(newContext.text(secret)).not.toBe(secret);
  });
  test('B03: processing over the existing discovery limit fails build rather than sending partial knowledge', async () => {
    observe('big', 'safe');
    const raw = fixture.session.events.at(-1);
    if (raw === undefined) throw new Error('missing result');
    fixture.session.events[raw.seq] = {
      ...raw,
      data: {
        message: {
          source: { kind: 'tool', callId: 'big' },
          content: [{ type: 'text', text: 'x'.repeat(16 * 1024 * 1024 + 1) }],
        },
      },
    };
    await expect(
      prepareReviewSnapshot(options(), fixture.workflow),
    ).rejects.toThrow(/credential redaction/);
  });
  test('ask human binding remains native and a stored ask result never duplicates it', async () => {
    const exec = fixture.exec('ask', 'ask_user_question');
    fixture.session.append('tool/call', {
      callId: 'ask',
      name: 'ask_user_question',
      arguments: { questions: [{ id: 'q', question: 'continue?' }] },
    });
    fixture.observer.observe(exec, {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            callId: 'ask',
            questions: [{ id: 'q', question: 'continue?' }],
            answers: [{ id: 'q', selected: ['yes'] }],
          }),
        },
      ],
    });
    fixture.session.append('tool/result', {
      message: {
        source: { kind: 'tool', callId: 'ask' },
        isError: false,
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              callId: 'ask',
              answers: [{ id: 'q', selected: ['yes'] }],
            }),
          },
        ],
      },
    });
    const read = vi.fn(fixture.reader.read);
    const source = await captureSnapshotSources(
      options({ toolResults: { ...fixture.reader, read } }),
    );
    expect(read).not.toHaveBeenCalled();
    expect(
      sourceEvents(source).filter((event) => event.kind === 'human'),
    ).toHaveLength(1);
    expect(
      sourceEvents(source).some(
        (event) => event.kind === 'result' && event.callId === 'ask',
      ),
    ).toBe(false);
  });
});
