/** Real retained receipts must preserve source identity under the production C cap. */
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  test,
  vi,
} from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { installSessionRecordApi } from '../../src/records.js';
import { prepareReviewSnapshot } from '../../src/snapshot.js';
import type { ReviewSnapshot } from '../../src/types.js';
import {
  renderChatRequest,
  renderChatUser,
  renderDecisionRequest,
} from '../../src/reviewer/prompt.js';
import { recordingSessionApi } from '../helpers/session-records.js';
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

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected structured recovered source');
  return { ...value };
}
function tokens(snapshot: ReviewSnapshot): readonly number[] {
  return [
    renderChatRequest(snapshot).estimatedInputTokens,
    renderDecisionRequest(renderChatUser(snapshot)).estimatedInputTokens,
  ];
}
function collect(stdout: string, stderr: string, mediaCount = 1) {
  const callId = 'retained-budget';
  const exec = fixture.exec(callId);
  fixture.session.append('tool/call', {
    callId,
    name: exec.name,
    arguments: exec.arguments,
  });
  fixture.observer.begin(exec);
  fixture.observer.observe(exec, {
    isError: false,
    content: [
      { type: 'text', channel: 'stdout', source: 'native-out', text: stdout },
      { type: 'text', channel: 'stderr', source: 'native-err', text: stderr },
      ...Array.from({ length: mediaCount }, (_, index) => ({
        type: 'image',
        mimeType: 'image/png',
        url: `https://example.test/media/${String(index)}`,
        data: 'BINARY_BODY_MUST_STAY_OMITTED',
      })),
    ],
  });
  fixture.session.append('user/message', {
    source: { kind: 'user' },
    content: [{ type: 'text', text: 'continue the observed workflow' }],
  });
  return fixture.audit.getToolResult('session', callId);
}
async function prepare() {
  const read = vi.fn(fixture.reader.read);
  const prepared = await prepareReviewSnapshot(
    {
      agent: { session: fixture.session },
      tool: 'bash',
      arguments: { command: 'echo pending' },
      callId: 'pending',
      cwd: fixture.root,
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'budget-source',
      toolResults: { ...fixture.reader, read },
    },
    fixture.workflow,
  );
  return { ...prepared, read };
}

test.each([false, true])(
  'C2-B01: real receipt preserves channels, media and byte ranges under default C (collection gap %s)',
  async (collectionGap) => {
    const stdout = 'α😀\n'.repeat(collectionGap ? 180_000 : 6_000);
    const stderr = 'observed stderr\n'.repeat(100);
    const stored = collect(stdout, stderr);
    expect(stored.state).toBe('found');
    expect(stored.receipt).not.toBeNull();
    expect(stored.metadata?.localTruncation).toBe(
      collectionGap ? 'collection-limit' : null,
    );
    const before = JSON.stringify(stored);
    const prepared = await prepare();
    const snapshot = prepared.bundle.snapshot;
    const prefix = snapshot.prefix;
    if (prefix === undefined) throw new Error('missing actual prefix');
    const selected = prefix.local.events.filter(
      (event) =>
        (event.kind === 'call' || event.kind === 'result') &&
        event.callId === 'retained-budget',
    );
    expect(selected).toHaveLength(2);
    const result = selected.find((event) => event.kind === 'result');
    if (result?.kind !== 'result' || result.body.state !== 'present')
      throw new Error('missing recovered result');
    expect(result.collection).toMatchObject({ save: 'saved', read: 'found' });
    const content = record(result.body.content);
    expect(content['processingVersion']).toBe('tool-result-v1');
    expect(content['parts']).toEqual(stored.metadata?.parts);
    expect(content['ranges']).toEqual(stored.metadata?.ranges);
    expect(content['sha256']).toBe(stored.metadata?.sha256);
    expect(content['budgetTruncated']).toBe(true);
    expect(content['parts']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: 'text',
          channel: 'stdout',
          source: 'native-out',
        }),
        expect.objectContaining({
          kind: 'text',
          channel: 'stderr',
          source: 'native-err',
        }),
        expect.objectContaining({
          kind: 'media',
          mediaType: 'image/png',
          reference: 'https://example.test/media/0',
        }),
      ]),
    );
    const fragments: readonly unknown[] = Array.isArray(content['fragments'])
      ? content['fragments']
      : [];
    expect(fragments.length).toBeGreaterThan(0);
    const source = Buffer.from(stdout + stderr);
    for (const entry of fragments) {
      const fragment = record(entry);
      const start = fragment['start'];
      const end = fragment['end'];
      const text = fragment['text'];
      if (
        typeof start !== 'number' ||
        typeof end !== 'number' ||
        typeof text !== 'string'
      )
        throw new Error('invalid source byte fragment');
      expect(text).toBe(source.subarray(start, end).toString());
      expect(Buffer.byteLength(text)).toBe(end - start);
      expect(
        stored.fragments.some(
          (original) => start >= original.start && end <= original.end,
        ),
      ).toBe(true);
    }
    expect(JSON.stringify(content)).not.toContain(
      'BINARY_BODY_MUST_STAY_OMITTED',
    );
    expect(
      result.body.truncations?.filter((item) => item.source === 'collection') ??
        [],
    ).toHaveLength(collectionGap ? 1 : 0);
    expect(snapshot.budget.truncatedSegments).toContain('CONTEXT');
    const without = {
      ...snapshot,
      prefix: {
        ...prefix,
        local: {
          ...prefix.local,
          events: prefix.local.events.filter(
            (event) => !selected.includes(event),
          ),
        },
      },
    };
    const full = tokens(snapshot);
    const base = tokens(without);
    expect(Math.max(...full)).toBeLessThanOrEqual(6000);
    expect(
      Math.max(...full.map((count, index) => count - (base[index] ?? 0))),
    ).toBeLessThanOrEqual(600);
    expect(prepared.read).toHaveBeenCalledTimes(1);
    const original = JSON.stringify(snapshot);
    prepared.rebuild(['later-known-value']);
    expect(prepared.read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(snapshot)).toBe(original);
    expect(
      JSON.stringify(
        fixture.audit.getToolResult(
          'session',
          'retained-budget',
          stored.receipt ?? undefined,
        ),
      ),
    ).toBe(before);
  },
);

test('C2-B01: actual irreducible stored identities above C omit the whole unit with an explicit budget gap', async () => {
  const stored = collect(
    'observed stdout\n'.repeat(1000),
    'observed stderr',
    32,
  );
  expect(stored.state).toBe('found');
  expect(stored.metadata?.parts).toHaveLength(34);
  const prepared = await prepare();
  const snapshot = prepared.bundle.snapshot;
  expect(
    snapshot.prefix?.local.events.filter(
      (event) =>
        (event.kind === 'call' || event.kind === 'result') &&
        event.callId === 'retained-budget',
    ),
  ).toEqual([]);
  expect(snapshot.prefix?.omissions).toEqual(
    expect.arrayContaining([expect.objectContaining({ cause: 'budget' })]),
  );
  expect(snapshot.budget.truncatedSegments).toContain('CONTEXT');
  expect(Math.max(...tokens(snapshot))).toBeLessThanOrEqual(6000);
  expect(prepared.read).toHaveBeenCalledTimes(1);
  expect(
    fixture.audit.getToolResult(
      'session',
      'retained-budget',
      stored.receipt ?? undefined,
    ).metadata,
  ).toEqual(stored.metadata);
});

test('C2-B01: credential-masked metadata values cannot disable receipt-based identity preservation', async () => {
  const stored = collect('observed stdout\n'.repeat(3000), 'observed stderr');
  fixture.workflow.discover({ token: 'tool-result-v1' });
  const prepared = await prepare();
  const event = prepared.bundle.snapshot.prefix?.local.events.find(
    (item) => item.kind === 'result',
  );
  if (event?.kind !== 'result' || event.body.state !== 'present')
    throw new Error('missing actual retained result');
  const content = record(event.body.content);
  expect(content['parts']).toEqual(stored.metadata?.parts);
  expect(content['ranges']).toEqual(stored.metadata?.ranges);
  expect(content['processingVersion']).not.toBe('tool-result-v1');
  expect(content['budgetTruncated']).toBe(true);
  expect(Math.max(...tokens(prepared.bundle.snapshot))).toBeLessThanOrEqual(
    6000,
  );
});
