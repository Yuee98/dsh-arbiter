import { describe, expect, test } from 'vitest';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { readSessionLog } from '../src/snapshot/log.js';
import {
  discoverLog,
  redactLog,
  sourceContentText,
} from '../src/snapshot/source-redaction.js';

const marker = /\[redacted:v1:[a-z-]+:[a-f0-9]{64}\]/u;
const masked: unknown = expect.stringMatching(marker);

describe('safe source payloads', () => {
  test('known values equal to finite protocol tags never erase the current human projection', () => {
    const content = [
      { type: 'text', text: 'only inspect local files' },
      {
        type: 'image',
        mimeType: 'image/png',
        reference: 'image-secret-ref',
        attachment: {
          attachmentId: 'image-secret-id',
          mediaType: 'image/png',
          width: 4,
          bytes: 8,
          name: 'image',
        },
      },
    ];
    const log = readSessionLog({
      snapshotEvents: () => [
        { seq: 1, type: 'user/message', data: { content } },
      ],
    });
    const redactor = new CredentialRedactor('protocol-fields', [
      'text',
      'type',
      'image',
      'mediaType',
      'width',
      'bytes',
    ]);
    discoverLog(log, redactor);
    const safe = redactLog(log, redactor);
    expect(safe.events[0]?.data).toMatchObject({
      content: [
        { type: 'text', text: 'only inspect local files' },
        {
          type: 'image',
          mimeType: 'image/png',
          reference: masked,
          attachment: {
            attachmentId: masked,
            mediaType: 'image/png',
            width: 4,
            bytes: 8,
            name: masked,
          },
        },
      ],
    });
    const event = safe.events[0];
    if (
      event === undefined ||
      event.data === null ||
      typeof event.data !== 'object'
    )
      throw new Error('safe event missing');
    expect(sourceContentText(Reflect.get(event.data, 'content'))).toBe(
      'only inspect local files',
    );
  });
  test('tool results keep structured payloads, media metadata and original block positions', () => {
    const content = [
      { type: 'text', text: 'pass', annotations: { page: 3 } },
      { type: 'text', text: 'word=joined-secret\nkeep recipient@example.test' },
      {
        type: 'image',
        reference: 'media-1',
        mimeType: 'image/png',
        omission: 'not-loaded',
        metadata: { token: 'media-secret', width: 64 },
      },
      { type: 'text', text: 'pass' },
      { type: 'audio', reference: 'media-2' },
      { type: 'text', text: 'word=ordinary' },
      {
        type: 'structured',
        payload: { password: 'payload-secret', path: '/tmp/output', count: 7 },
      },
    ];
    const object = {
      rows: [{ token: 'object-secret', recipient: 'ops@example.test' }],
      total: 1,
    };
    const log = readSessionLog({
      snapshotEvents: () => [
        {
          seq: 1,
          type: 'tool/result',
          data: { message: { source: { callId: 'call-1' }, content } },
        },
        { seq: 2, type: 'tool/result', data: { content: object } },
      ],
    });
    const original = JSON.stringify(log);
    const redactor = new CredentialRedactor('safe-source');
    discoverLog(log, redactor);
    const safe = redactLog(log, redactor);
    expect(safe.own[0]).toBe(safe.events[0]);
    const cleaned = JSON.stringify(safe);
    for (const secret of [
      'joined-secret',
      'media-secret',
      'payload-secret',
      'object-secret',
    ])
      expect(cleaned).not.toContain(secret);
    expect(safe.own[0]?.data).toMatchObject({
      message: {
        source: { callId: 'call-1' },
        content: [
          { type: 'text', text: 'pass', annotations: { page: 3 } },
          { type: 'text', text: masked },
          {
            type: 'image',
            reference: 'media-1',
            mimeType: 'image/png',
            omission: 'not-loaded',
            metadata: { token: masked, width: 64 },
          },
          { type: 'text', text: 'pass' },
          { type: 'audio', reference: 'media-2' },
          { type: 'text', text: 'word=ordinary' },
          {
            type: 'structured',
            payload: {
              password: masked,
              path: '/tmp/output',
              count: 7,
            },
          },
        ],
      },
    });
    expect(safe.own[1]?.data).toMatchObject({
      content: {
        rows: [
          {
            token: masked,
            recipient: 'ops@example.test',
          },
        ],
        total: 1,
      },
    });
    expect(cleaned).toContain('recipient@example.test');
    expect(JSON.stringify(log)).toBe(original);
  });
  test('a replacement spanning raw and escaped JSON tokens stays in its original first block', () => {
    const redactor = new CredentialRedactor('json-source');
    const json =
      '{ "password": "quoted-\\u0022secret", "authorization": 87654, "count": 87654, "nested": {"token":"nested-secret"} }';
    const at = json.indexOf('u0022') + 3;
    const blocks = [
      json.slice(0, at),
      json.slice(at, at + 20),
      json.slice(at + 20),
    ];
    const safe = redactor.textBlockValues(blocks);
    expect(safe).toHaveLength(3);
    expect(safe[0]).toMatch(marker);
    expect(JSON.stringify(safe)).not.toContain('quoted-');
    expect(JSON.stringify(safe)).not.toContain('secret');
    const decoded: unknown = JSON.parse(safe.join(''));
    expect(decoded).toMatchObject({
      password: masked,
      authorization: masked,
      count: 87654,
      nested: { token: masked },
    });
    expect(
      sourceContentText(safe.map((text) => ({ type: 'text', text }))),
    ).toBe(safe.join(''));
    expect(redactor.textBlocks(blocks)).toBe(safe.join(''));
  });
  test('ordinary JSON block boundaries and source metadata survive unchanged', () => {
    const blocks = ['{ "count":', ' 17, "path": "/tmp/a" }'];
    const redactor = new CredentialRedactor('ordinary-json');
    expect(redactor.textBlockValues(blocks)).toEqual(blocks);
    expect(
      sourceContentText([
        { type: 'text', text: 'first' },
        { type: 'image', reference: 'local' },
        { type: 'text', text: 'second' },
      ]),
    ).toBe('first\nsecond');
  });
  test('every JSON token boundary preserves shape, counts and credential identity', () => {
    const redactor = new CredentialRedactor('json-all-boundaries');
    const json =
      '{"2":{"password":{"value":123}},"1":[true,null,"ordinary"],"token":"escaped-\\u0022value","count":123}';
    const expected = redactor.text(json);
    for (let at = 0; at <= json.length; at += 1) {
      const safe = redactor.textBlockValues([
        json.slice(0, at),
        json.slice(at),
      ]);
      expect(safe).toHaveLength(2);
      expect(JSON.parse(safe.join(''))).toEqual(JSON.parse(expected));
      expect(safe.join('')).not.toContain('escaped-');
    }
  });
  test('ambiguous JSON key mappings fail safely instead of retaining overwritten raw values', () => {
    const redactor = new CredentialRedactor('duplicate-json');
    expect(() =>
      redactor.textBlockValues([
        '{"password":"first-secret",',
        '"password":"second-secret"}',
      ]),
    ).toThrow('could not be safely mapped');
  });
  test('direct JSON text cannot hide explicit credentials in overwritten properties', () => {
    const text = '{"note":"password=overwritten-secret","note":"ordinary"}';
    expect(() => new CredentialRedactor('duplicate-direct').text(text)).toThrow(
      'could not be safely mapped',
    );
    expect(() =>
      new CredentialRedactor('duplicate-single').textBlockValues([text]),
    ).toThrow('could not be safely mapped');
  });
});
