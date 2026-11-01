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
      {},
    );
    expect(mirror.parts).toHaveLength(2);
    const distinct = toolResultMaterial(
      { content, value: { count: 2 } },
      new CredentialRedactor('session'),
      {},
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
        {},
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
  test.each([false, true])(
    'S01: invocation knowledge precedes same/different channel splitting (%s)',
    (differentChannels) => {
      const secret = 'opaque-workflow-secret-42';
      const exec = {
        ...fixture.exec('argument-split'),
        arguments: Object.freeze({ token: secret }),
      };
      const content = Object.freeze([
        Object.freeze({ type: 'text', text: 'opaque-', channel: 'stdout' }),
        Object.freeze({
          type: 'text',
          text: 'workflow-secret-42',
          channel: differentChannels ? 'stderr' : 'stdout',
        }),
      ]);
      const result = Object.freeze({
        isError: false,
        content,
        value: structuredClone(content),
      });
      const original = JSON.stringify({ result, arguments: exec.arguments });
      fixture.observer.begin(exec);
      fixture.observer.observe(exec, result);
      const saved = fixture.audit.getToolResult('session', 'argument-split');
      expect(saved.state).toBe('found');
      expect(saved.metadata?.parts.map((part) => part.channel)).toEqual([
        'stdout',
        differentChannels ? 'stderr' : 'stdout',
      ]);
      expect(JSON.stringify(saved)).toContain('[redacted:v1:token:');
      expect(JSON.stringify(saved)).not.toContain('workflow-secret-42');
      expect(JSON.stringify(saved)).not.toContain('opaque-');
      expect(
        readFileSync(fixture.audit.databasePath).includes(Buffer.from(secret)),
      ).toBe(false);
      expect(JSON.stringify({ result, arguments: exec.arguments })).toBe(
        original,
      );
    },
  );
  test.each(['content', 'value'] as const)(
    'S02: ordinary omitted-state JSON survives in %s',
    (location) => {
      const business = Object.freeze({
        type: 'invoice',
        state: 'omitted',
        total: 42,
        reason: 'optional-detail-omitted',
      });
      const result =
        location === 'content'
          ? { content: [business] }
          : {
              content: [{ type: 'text', text: 'Invoice summarised' }],
              value: business,
            };
      const original = JSON.stringify(result);
      fixture.observer.observe(fixture.exec('business'), result);
      const saved = fixture.audit.getToolResult('session', 'business');
      expect(saved.metadata?.contentState).toBe('available');
      expect(saved.metadata?.parts.at(-1)).toMatchObject({
        kind: 'json',
        channel: location,
      });
      const json = saved.metadata?.parts.at(-1);
      if (json === undefined) throw new Error('missing JSON part');
      const retained = Buffer.from(
        saved.fragments.map((fragment) => fragment.text).join(''),
      );
      expect(
        JSON.parse(
          retained.subarray(json.start, json.start + json.bytes).toString(),
        ),
      ).toEqual(business);
      expect(JSON.stringify(result)).toBe(original);
    },
  );
  test('S02: ordinary omitted-state text and genuine media retain distinct provenance', () => {
    fixture.observer.observe(fixture.exec('media-provenance'), {
      content: [
        { type: 'text', state: 'omitted', text: 'ordinary text survives' },
        {
          type: 'image',
          data: 'BINARY_MEDIA_SENTINEL',
          url: 'https://example.test/image',
        },
        { type: 'text', text: 'data:;base64,INLINE_MEDIA_SENTINEL' },
        { type: 'text', text: 'data:image/png;base64,INLINE_IMAGE_SENTINEL' },
      ],
      value: { type: 'audio', data: 'AUDIO_MEDIA_SENTINEL' },
    });
    const saved = fixture.audit.getToolResult('session', 'media-provenance');
    expect(saved.metadata?.parts.map((part) => part.kind)).toEqual([
      'text',
      'media',
      'media',
      'text',
      'media',
    ]);
    expect(saved.metadata?.parts.at(-1)?.channel).toBe('value');
    expect(JSON.stringify(saved)).toContain('ordinary text survives');
    expect(JSON.stringify(saved)).not.toContain('MEDIA_SENTINEL');
    expect(JSON.stringify(saved)).not.toContain('IMAGE_SENTINEL');
  });
  test('PR-B02: stale and saved executions remain terminal across duplicate notifications', () => {
    const stale = fixture.exec('stale-repeat');
    fixture.observer.begin(stale);
    fixture.audit.clearCalls();
    fixture.observer.observe(stale, {
      content: [{ type: 'text', text: 'cleared-secret-body' }],
    });
    fixture.observer.begin(stale);
    fixture.observer.observe(stale, {
      content: [{ type: 'text', text: 'cleared-secret-body' }],
    });
    expect(fixture.audit.getToolResult('session', 'stale-repeat').state).toBe(
      'absent',
    );
    const saved = fixture.exec('saved-repeat');
    fixture.observer.begin(saved);
    fixture.observer.observe(saved, {
      content: [{ type: 'text', text: 'first final' }],
    });
    fixture.observer.observe(saved, {
      content: [{ type: 'text', text: 'later final' }],
    });
    expect(
      fixture.audit
        .getToolResult('session', 'saved-repeat')
        .fragments.map((part) => part.text)
        .join(''),
    ).toBe('first final');
    expect(
      fixture.session.events.filter((event) => event.type === RESULT_REFERENCE),
    ).toHaveLength(2);
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
    expect(refs.map((ref) => ref?.save)).toEqual(['stale', 'saved']);
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
