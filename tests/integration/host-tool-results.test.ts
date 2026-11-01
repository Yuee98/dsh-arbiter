import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';
import { installSessionRecordApi } from '../../src/records.js';
import {
  recordingSessionApi,
  admitSession,
} from '../helpers/session-records.js';
import {
  resultStatus,
  toolResultMaterial,
} from '../../src/host/tool-result-material.js';
import { CredentialRedactor } from '../../src/reviewer/credential-redactor.js';
import {
  RESULT_REFERENCE,
  resultReference,
} from '../../src/snapshot/tool-result-reference.js';
import { observerFixture } from './result-observer-fixture.js';

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
  fixture.close();
});

describe('independent final host result collection', () => {
  test.each([
    [
      { isError: false, content: [{ type: 'text', text: 'listing' }] },
      'success',
      'available',
    ],
    [
      { isError: true, content: [{ type: 'text', text: 'failure' }] },
      'failure',
      'available',
    ],
    [{}, 'unknown', 'no-result'],
    [{ isError: false, content: [] }, 'success', 'empty'],
    [{ content: [{ type: 'text', text: '' }] }, 'unknown', 'empty'],
    [
      {
        content: [
          {
            type: 'image',
            data: 'MEDIA_BODY_SENTINEL',
            mimeType: 'image/png',
            url: 'https://example.test/image',
          },
        ],
      },
      'unknown',
      'unsupported',
    ],
    [{ value: { key: 'business', code: 'YWJj' } }, 'unknown', 'available'],
  ] as const)(
    'stores observed status and body state separately %#',
    (result, status, contentState) => {
      const exec = fixture.exec('query');
      fixture.observer.begin(exec);
      fixture.observer.observe(exec, result);
      const saved = fixture.audit.getToolResult('session', 'query');
      expect(saved.state).toBe('found');
      expect(saved.metadata).toMatchObject({ status, contentState });
      expect(fixture.host.runtime.pending.size).toBe(0);
      expect(fixture.host.runtime.reviewCounts.size).toBe(0);
      expect(fixture.audit.listCalls({}).total).toBe(0);
      const event = fixture.session.events.find(
        (entry) => entry.type === RESULT_REFERENCE,
      );
      expect(event).toBeDefined();
      if (event === undefined) throw new Error('no reference');
      expect(resultReference(event, 'session')).toMatchObject({
        status,
        contentState,
        save: 'saved',
        receipt: saved.receipt,
      });
      expect(JSON.stringify(saved)).not.toContain('MEDIA_BODY_SENTINEL');
    },
  );
  test('normalizes real mirror shape once; independent channels and canonical value remain distinct', () => {
    const content = [
      { type: 'text', text: 'stdout', channel: 'stdout' },
      { type: 'text', text: 'stderr', channel: 'stderr' },
    ];
    const mirror = toolResultMaterial(
      { content, value: structuredClone(content) },
      new CredentialRedactor('session'),
    );
    expect(mirror.parts).toHaveLength(2);
    const distinct = toolResultMaterial(
      { content, value: { count: 2 } },
      new CredentialRedactor('session'),
    );
    expect(distinct.parts).toHaveLength(3);
    expect(distinct.parts.map((entry) => entry.channel)).toEqual([
      'stdout',
      'stderr',
      'value',
    ]);
    expect(
      toolResultMaterial(
        { content: [{ type: 'text', text: 'not json' }], value: null },
        new CredentialRedactor('session'),
      ).parts,
    ).toHaveLength(2);
    expect(resultStatus({})).toBe('unknown');
  });
  test('discovers raw credentials before nested media projection and does not mutate the host result', () => {
    const secret = 'synthetic-result-credential-42';
    const result = Object.freeze({
      isError: false,
      content: Object.freeze([
        {
          type: 'text',
          text: JSON.stringify({
            token: secret,
            image: { type: 'image', data: 'NESTED_MEDIA_SENTINEL' },
            business: { key: 'ordinary', code: 'YWJj' },
          }),
        },
      ]),
      value: { echo: secret },
    });
    const original = JSON.stringify(result);
    const exec = fixture.exec('safe');
    fixture.observer.begin(exec);
    fixture.observer.observe(exec, result);
    const saved = fixture.audit.getToolResult('session', 'safe');
    expect(saved.state).toBe('found');
    const text = JSON.stringify(saved);
    expect(text).not.toContain(secret);
    expect(text).not.toContain('NESTED_MEDIA_SENTINEL');
    expect(text).toContain('YWJj');
    expect(JSON.stringify(result)).toBe(original);
    expect(
      readFileSync(fixture.audit.databasePath).includes(Buffer.from(secret)),
    ).toBe(false);
  });
  test('retains actual upstream truncation without inventing exit codes or continuation', () => {
    const result = {
      isError: false,
      value: {
        stdout: { text: 'tail', truncated: true },
        stderr: { text: '', truncated: false },
        exitCode: 0,
      },
      content: [{ type: 'text', text: 'tail' }],
    };
    fixture.observer.observe(fixture.exec('upstream'), result);
    const saved = fixture.audit.getToolResult('session', 'upstream');
    expect(saved.metadata?.upstreamTruncated).toBe(true);
    expect(saved.metadata?.origin).not.toHaveProperty('seq', 0);
    expect(saved.metadata?.callStartedAt).toBeNull();
  });
  test('uses common text-block redaction before persistence can separate blocks', () => {
    const content = [
      { type: 'text', text: '{"token":"opaque-' },
      { type: 'text', text: 'workflow-secret-42"}' },
    ];
    fixture.observer.observe(fixture.exec('split'), {
      isError: false,
      content,
      value: structuredClone(content),
    });
    const output = fixture.audit.getToolResult('session', 'split');
    expect(output.state).toBe('found');
    const text = JSON.stringify(output);
    expect(text).not.toContain('workflow-secret-42');
    expect(text).not.toContain('opaque-');
    expect(content[1]?.text).toBe('workflow-secret-42"}');
  });
  test('unserializable canonical output reports unavailable without raw fallback', () => {
    const cycle: Record<string, unknown> = {};
    cycle['self'] = cycle;
    const exec = fixture.exec('cycle');
    fixture.observer.observe(exec, { isError: false, value: cycle });
    expect(
      fixture.audit.getToolResult('session', 'cycle').metadata,
    ).toMatchObject({
      status: 'success',
      contentState: 'unavailable',
      unavailableReason: 'result-processing-failed',
    });
  });
  test('clear fences an in-flight result and duplicate finalization never claims payload equality', () => {
    const old = fixture.exec('old');
    fixture.observer.begin(old);
    fixture.audit.clearCalls();
    fixture.observer.observe(old, {
      isError: false,
      content: [{ type: 'text', text: 'old-body' }],
    });
    expect(fixture.audit.getToolResult('session', 'old').state).toBe('absent');
    const exec = fixture.exec('repeat');
    fixture.observer.begin(exec);
    fixture.observer.observe(exec, {
      content: [{ type: 'text', text: 'first' }],
    });
    const first = fixture.audit.getToolResult('session', 'repeat');
    fixture.observer.observe(exec, {
      content: [{ type: 'text', text: 'second' }],
    });
    expect(fixture.audit.getToolResult('session', 'repeat')).toEqual(first);
    const refs = fixture.session.events
      .filter((event) => event.type === RESULT_REFERENCE)
      .map((event) => resultReference(event, 'session'));
    expect(refs.map((ref) => ref?.save)).toEqual([
      'stale',
      'saved',
      'already-recorded',
    ]);
  });
  test.each(['disabled', 'audit-off', 'unmanaged', 'unloaded'] as const)(
    '%s stops observation without writes',
    (state) => {
      if (state === 'disabled')
        fixture.host.runtime.config = {
          ...fixture.host.runtime.config,
          enabled: false,
        };
      if (state === 'audit-off')
        fixture.host.runtime.config = {
          ...fixture.host.runtime.config,
          audit: { ...fixture.host.runtime.config.audit, enabled: false },
        };
      if (state === 'unmanaged')
        admitSession(fixture.session, { enabled: false });
      if (state === 'unloaded') fixture.disposeObserver();
      const before = fixture.session.events.length;
      const exec = fixture.exec(state);
      fixture.observer.begin(exec);
      fixture.observer.observe(exec, {
        content: [{ type: 'text', text: 'not-collected' }],
      });
      expect(fixture.audit.getToolResult('session', state).state).toBe(
        'absent',
      );
      expect(fixture.session.events).toHaveLength(before);
    },
  );
  test('persistent reference failure keeps diagnostics bounded', () => {
    installSessionRecordApi(null);
    try {
      for (let index = 0; index < 205; index += 1)
        fixture.observer.observe(fixture.exec(`record-gap-${String(index)}`), {
          content: [],
        });
      expect(fixture.host.runtime.sessionRecordErrors.size).toBe(200);
      expect(fixture.host.runtime.sessionRecordErrors.has('record-gap-0')).toBe(
        false,
      );
      expect(
        fixture.host.runtime.sessionRecordErrors.has('record-gap-204'),
      ).toBe(true);
    } finally {
      installSessionRecordApi(recordingSessionApi());
    }
  });
  test('actual SQLite write failure and missing public writer keep the host return unchanged', () => {
    const db = new DatabaseSync(fixture.audit.databasePath);
    try {
      db.exec(
        "CREATE TRIGGER fail_result BEFORE INSERT ON tool_results BEGIN SELECT RAISE(FAIL, 'controlled-result-failure'); END",
      );
      const result = Object.freeze({
        isError: false,
        content: [{ type: 'text', text: 'real-return' }],
      });
      const original = JSON.stringify(result);
      fixture.observer.observe(fixture.exec('sql-fail'), result);
      expect(JSON.stringify(result)).toBe(original);
      const event = fixture.session.events.at(-1);
      if (event === undefined) throw new Error('no failure reference');
      expect(resultReference(event, 'session')?.save).toBe('failed');
      db.exec('DROP TRIGGER fail_result');
      installSessionRecordApi(null);
      const count = fixture.session.events.length;
      fixture.observer.observe(fixture.exec('writer-fail'), result);
      expect(fixture.audit.getToolResult('session', 'writer-fail').state).toBe(
        'found',
      );
      expect(fixture.session.events).toHaveLength(count);
      expect(fixture.host.runtime.sessionRecordErrors.get('writer-fail')).toBe(
        'tool result reference could not be written',
      );
    } finally {
      installSessionRecordApi(recordingSessionApi());
      db.close();
    }
  });
});
