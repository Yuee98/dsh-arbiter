import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { PROBE_SNAPSHOT } from '../../src/reviewer/diagnostic.js';
import {
  resultCall,
  resultFile,
  resultFixture,
  resultMetadata,
  resultObservation,
} from './tool-result-helpers.js';

let fixture: ReturnType<typeof resultFixture>;
beforeEach(() => {
  fixture = resultFixture();
});
afterEach(() => {
  fixture.close();
});

describe('post-execution result persistence', () => {
  test.each([65_535, 65_536, 65_537, 1_048_575, 1_048_576, 1_048_577])(
    'shares the exact %i-byte boundary across channels',
    (bytes) => {
      const store = fixture.open();
      const observation = resultObservation({
        parts: [
          {
            kind: 'text',
            channel: 'stdout',
            text: 'a'.repeat(Math.floor(bytes / 2)),
          },
          {
            kind: 'text',
            channel: 'stderr',
            text: 'b'.repeat(bytes - Math.floor(bytes / 2)),
          },
        ],
      });
      expect(store.saveToolResult(observation).state).toBe('saved');
      const result = store.getToolResult('session', 'query');
      expect(result.state).toBe('found');
      expect(result.storage).toBe(bytes <= 65_536 ? 'inline' : 'file');
      const metadata = resultMetadata(result);
      expect(metadata.sourceBytes).toBe(bytes);
      expect(metadata.retainedBytes).toBeLessThanOrEqual(1_048_576);
      expect(metadata.parts.map((part) => part.channel)).toEqual([
        'stdout',
        'stderr',
      ]);
      expect(metadata.localTruncation).toBe(
        bytes > 1_048_576 ? 'collection-limit' : null,
      );
      const retained = result.fragments
        .map((fragment) => fragment.text)
        .join('');
      expect(Buffer.byteLength(retained)).toBe(metadata.retainedBytes);
      expect(metadata.sha256).toBe(
        createHash('sha256').update(retained).digest('hex'),
      );
      const complete = observation.parts
        .map((part) => (part.kind === 'text' ? part.text : ''))
        .join('');
      const expected =
        bytes <= 1_048_576
          ? complete
          : complete.slice(0, 524_288) + complete.slice(-524_288);
      expect(retained).toBe(expected);
      expect(metadata.ranges).toEqual(
        bytes <= 1_048_576
          ? [{ start: 0, end: bytes }]
          : [
              { start: 0, end: 524_288 },
              { start: bytes - 524_288, end: bytes },
            ],
      );
      const physical =
        result.fileRef === null
          ? null
          : readFileSync(resultFile(result, fixture.path)).length;
      expect(physical).toBe(bytes <= 65_536 ? null : metadata.retainedBytes);
    },
  );

  test('measures serialized JSON and multibyte text, then survives a restart without a calls row', () => {
    const store = fixture.open();
    const value = { entries: ['目录', '😀'], files: 2 };
    const text = '中'.repeat(22_000);
    const saved = store.saveToolResult(
      resultObservation({
        parts: [
          { kind: 'json', channel: 'structured', value },
          { kind: 'text', channel: 'stdout', text },
        ],
      }),
    );
    expect(saved.state).toBe('saved');
    expect(store.listCalls({}).total).toBe(0);
    store.close();
    const result = fixture.open().getToolResult('session', 'query');
    expect(result.state).toBe('found');
    expect(result.storage).toBe('file');
    expect(resultMetadata(result).sourceBytes).toBe(
      Buffer.byteLength(JSON.stringify(value) + text),
    );
    expect(result.fragments[0]?.text).toBe(JSON.stringify(value) + text);
  });

  test('bounds an enormous UTF-8 single line and labels JSON fragments honestly', () => {
    const store = fixture.open();
    const value = { value: '😀中'.repeat(200_000) };
    expect(
      store.saveToolResult(
        resultObservation({
          upstreamTruncated: true,
          parts: [{ kind: 'json', channel: 'structured', value }],
        }),
      ).state,
    ).toBe('saved');
    const result = store.getToolResult('session', 'query');
    const metadata = resultMetadata(result);
    expect(metadata.upstreamTruncated).toBe(true);
    expect(metadata.localTruncation).toBe('collection-limit');
    expect(result.fragments).toHaveLength(2);
    for (const fragment of result.fragments) {
      expect(fragment.text).not.toContain('�');
      expect(Buffer.byteLength(fragment.text)).toBe(
        fragment.end - fragment.start,
      );
      expect(() => {
        JSON.parse(fragment.text);
      }).toThrow();
    }
    expect(metadata.retainedBytes).toBeLessThanOrEqual(1_048_576);
    expect(metadata.retainedBytes).toBeGreaterThan(1_048_560);
  });

  test('aligns nearby newlines and preserves the missing middle as separate ranges', () => {
    const store = fixture.open();
    const line = `${'x'.repeat(998)}\n`;
    store.saveToolResult(
      resultObservation({
        parts: [{ kind: 'text', channel: 'stdout', text: line.repeat(1300) }],
      }),
    );
    const result = store.getToolResult('session', 'query');
    expect(result.fragments).toHaveLength(2);
    expect(result.fragments[0]?.text.endsWith('\n')).toBe(true);
    expect(result.fragments[1]?.start).toBeGreaterThan(
      result.fragments[0]?.end ?? 0,
    );
    expect(resultMetadata(result).processingVersion).toBe('tool-result-v1');
  });

  test.each(['empty', 'no-result', 'unsupported', 'unavailable'] as const)(
    'distinguishes %s from absent and failed execution',
    (contentState) => {
      const store = fixture.open();
      const parts =
        contentState === 'unsupported'
          ? [
              {
                kind: 'media' as const,
                channel: 'image',
                mediaType: 'image/png',
                reference: 'attachment://image',
              },
            ]
          : [];
      expect(
        store.saveToolResult(
          resultObservation({ status: 'failure', contentState, parts }),
        ).state,
      ).toBe('saved');
      const result = store.getToolResult('session', 'query');
      expect(result.state).toBe('found');
      expect(result.storage).toBe('none');
      expect(resultMetadata(result)).toMatchObject({
        status: 'failure',
        contentState,
        retainedBytes: 0,
      });
      expect(store.getToolResult('session', 'never').state).toBe('absent');
    },
  );

  test('preserves text alongside unsupported media without expanding media bodies', () => {
    const store = fixture.open();
    store.saveToolResult(
      resultObservation({
        parts: [
          {
            kind: 'media',
            channel: 'attachment',
            mediaType: 'audio/ogg',
            reference: 'attachment://audio',
          },
          { kind: 'text', channel: 'stderr', text: 'decoder failed' },
        ],
      }),
    );
    const result = store.getToolResult('session', 'query');
    expect(result.fragments[0]?.text).toBe('decoder failed');
    expect(resultMetadata(result).parts[0]).toMatchObject({
      kind: 'media',
      bytes: 0,
      mediaType: 'audio/ogg',
      reference: 'attachment://audio',
    });
  });

  test('discovers credentials across channels before persistence and leaves execution inputs intact', () => {
    const store = fixture.open();
    const secret = 'result-credential-sentinel';
    const observation = resultObservation({
      invocation: { tool: 'bash', arguments: { password: secret } },
      parts: [
        {
          kind: 'text',
          channel: 'stdout',
          text: `${secret} ${'x'.repeat(70_000)}`,
        },
        { kind: 'json', channel: 'structured', value: { password: secret } },
      ],
    });
    const original = structuredClone(observation);
    expect(store.saveToolResult(observation).state).toBe('saved');
    expect(observation).toEqual(original);
    const result = store.getToolResult('session', 'query');
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(result.fragments[0]?.text).toContain('[redacted:v1:password:');
    expect(
      readFileSync(resultFile(result, fixture.path)).toString(),
    ).not.toContain(secret);
    for (const file of readdirSync(fixture.root).filter((file) =>
      statSync(join(fixture.root, file)).isFile(),
    ))
      expect(
        readFileSync(join(fixture.root, file)).includes(Buffer.from(secret)),
      ).toBe(false);
  });

  test('handles a credential split across explicit continuation parts', () => {
    const store = fixture.open();
    store.saveToolResult(
      resultObservation({
        parts: [
          { kind: 'text', channel: 'stdout', text: 'password=split-' },
          {
            kind: 'text',
            channel: 'stdout',
            text: 'credential\n',
            continuation: true,
          },
        ],
      }),
    );
    const result = store.getToolResult('session', 'query');
    expect(result.fragments[0]?.text).not.toContain('split-credential');
    expect(result.fragments[0]?.text).toContain('[redacted:v1:password:');
  });

  test('uses the same workflow credential identity as separately persisted call arguments', async () => {
    const store = fixture.open();
    store.enqueue(
      resultCall({ arguments: { password: 'cross-surface-secret' } }),
    );
    await store.flush();
    const argumentsText = JSON.stringify(store.getCall('query')?.['arguments']);
    const marker = argumentsText.match(
      /\[redacted:v1:password:[a-f0-9]+\]/u,
    )?.[0];
    if (marker === undefined)
      throw new Error('call arguments were not redacted');
    store.saveToolResult(
      resultObservation({
        parts: [
          {
            kind: 'text',
            channel: 'stdout',
            text: 'cross-surface-secret /ordinary/project/path',
          },
        ],
      }),
    );
    const body = store.getToolResult('session', 'query').fragments[0]?.text;
    expect(body).toContain(marker);
    expect(body).toContain('/ordinary/project/path');
    expect(body).not.toContain('cross-surface-secret');
  });

  test('records safe processing failure and permits repair without raw fallback', () => {
    const store = fixture.open();
    const cyclic: { self?: unknown } = {};
    cyclic.self = cyclic;
    expect(
      store.saveToolResult(
        resultObservation({
          parts: [{ kind: 'json', channel: 'structured', value: cyclic }],
        }),
      ).state,
    ).toBe('failed');
    expect(store.getToolResult('session', 'query').state).toBe(
      'storage-failed',
    );
    expect(store.health().state).toBe('degraded');
    expect(store.saveToolResult(resultObservation()).state).toBe('saved');
    expect(store.getToolResult('session', 'query').fragments[0]?.text).toBe(
      'directory entries\n',
    );
  });

  test('does not rewrite a saved pre-execution snapshot or lose the body when a call is replaced', async () => {
    const store = fixture.open();
    store.enqueue(resultCall({ snapshot: PROBE_SNAPSHOT }));
    await store.flush();
    const before = store.getCall('query')?.['snapshot'];
    expect(before).not.toBeNull();
    expect(store.saveToolResult(resultObservation()).state).toBe('saved');
    expect(store.getCall('query')?.['snapshot']).toEqual(before);
    store.enqueue(
      resultCall({ snapshot: PROBE_SNAPSHOT, executionStatus: 'success' }),
    );
    await store.flush();
    expect(store.getToolResult('session', 'query').state).toBe('found');
  });
});
