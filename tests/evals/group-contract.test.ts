import { describe, expect, it } from 'vitest';

import { compileCheckers } from '../../evals/src/data/schemas.js';
import { selectPointMaterial } from '../../evals/src/data/workflow-material.js';
import { collectionOf, workflow, childWorkflow } from './fixtures/workflow.js';
import { changeEvent, loadWorkflow, problemText } from './helpers/grouped.js';

const checkers = await compileCheckers();

describe('group envelope and source schema', () => {
  it('accepts the explicit version and refuses guessed formats and author answers', () => {
    expect(checkers.workflows(collectionOf(workflow())).ok).toBe(true);
    for (const value of [
      workflow(),
      [workflow()],
      { records: [workflow()] },
      { schemaVersion: 'future', records: [workflow()] },
      collectionOf({ ...workflow(), expectedRisk: 8 }),
      collectionOf(),
    ]) {
      expect(checkers.workflows(value).ok).toBe(false);
    }
  });

  it('distinguishes body empty/unavailable/omitted, execution failure and truncation origin', () => {
    const root = workflow();
    for (const body of [
      { state: 'empty' },
      { state: 'unavailable', reason: 'lost' },
      { state: 'unavailable', reason: 'unreadable' },
      {
        state: 'present',
        content: 'error output',
        truncations: [{ source: 'upstream', note: 'host omitted middle' }],
      },
      {
        state: 'present',
        content: { values: [1, 2] },
        truncations: [{ source: 'collection', note: 'collection limit' }],
      },
      {
        state: 'omitted',
        media: [
          { type: 'image/png', ref: 'selected-asset.png', note: '正文未提供' },
        ],
      },
    ]) {
      expect(
        checkers.workflows(
          collectionOf({
            ...root,
            events: root.events.map((event) =>
              event.kind === 'result'
                ? { ...event, status: 'failure', body }
                : event,
            ),
          }),
        ).ok,
      ).toBe(true);
    }
    for (const body of [
      { state: 'present', content: '' },
      { state: 'empty', content: 'hidden' },
      { state: 'unavailable' },
      {
        state: 'present',
        content: 'x',
        truncations: [{ source: 'unknown', note: 'x' }],
      },
    ]) {
      expect(
        checkers.workflows(
          collectionOf({
            ...root,
            events: root.events.map((event) =>
              event.kind === 'result' ? { ...event, body } : event,
            ),
          }),
        ).ok,
      ).toBe(false);
    }
  });
});

describe('event and point invariants', () => {
  it('keeps gaps, cross-turn answers, observed failures and an unlogged pending action', async () => {
    const loaded = await loadWorkflow();
    expect(loaded.problems).toEqual([]);
    const material = selectPointMaterial(
      loaded,
      'format-build',
      'format-repair',
    );
    expect(material.pending.callId).toBe('repair');
    expect(material.history.at(-1)).toMatchObject({
      eventId: 'build-result',
      status: 'failure',
    });
    expect(
      material.history.find((event) => event.kind === 'answer'),
    ).toMatchObject({ turnId: 'turn-2', askId: 'build-question' });
  });

  it.each([
    [
      'future result call',
      () => changeEvent('scan-result', { callId: 'build' }),
      'must exist earlier',
    ],
    [
      'wrong result session',
      () => changeEvent('scan-result', { sessionId: 'other' }),
      'unknown session',
    ],
    [
      'future ask',
      () => changeEvent('answer-build', { askId: 'not-yet-asked' }),
      'must exist earlier',
    ],
    [
      'duplicate native seq',
      () => changeEvent('scan-result', { seq: 2 }),
      'is not after',
    ],
    [
      'unknown point session',
      () => ({
        ...workflow(),
        points: [{ ...workflow().points[0], sessionId: 'missing' }],
      }),
      'unknown point session',
    ],
    [
      'future current result',
      () => ({
        ...workflow(),
        points: [{ ...workflow().points[0], cutoffEventId: 'clean-result' }],
      }),
      'already has a result',
    ],
    [
      'wrong cutoff session',
      () => ({
        ...childWorkflow(),
        points: [{ ...childWorkflow().points[0], cutoffEventId: 'parent-new' }],
      }),
      'not reachable in session',
    ],
    [
      'unknown cutoff',
      () => ({
        ...workflow(),
        points: [{ ...workflow().points[0], cutoffEventId: 'absent' }],
      }),
      'not reachable',
    ],
    [
      'wrong pending session',
      () => ({
        ...childWorkflow(),
        points: [
          {
            ...childWorkflow().points[0],
            pending: { callEventId: 'parent-tool' },
          },
        ],
      }),
      'not a call in session',
    ],
    [
      'bypass point',
      () => ({
        ...workflow(),
        points: [
          { ...workflow().points[0], pending: { callEventId: 'scan-call' } },
        ],
      }),
      'must bind a reviewer',
    ],
    [
      'duplicate call',
      () => changeEvent('build-call', { callId: 'clean' }),
      'duplicate call',
    ],
    [
      'duplicate ask',
      () => ({
        ...workflow(),
        events: [
          ...workflow().events,
          {
            eventId: 'repeat-ask',
            sessionId: 'main',
            seq: 10,
            turnId: null,
            kind: 'ask',
            askId: 'build-question',
            channel: 'agent',
            question: 'again',
          },
        ],
      }),
      'duplicate ask',
    ],
    [
      'duplicate event',
      () => changeEvent('build-call', { eventId: 'clean-call' }),
      'duplicate event',
    ],
    [
      'duplicate session',
      () => ({
        ...workflow(),
        sessions: [{ sessionId: 'main' }, { sessionId: 'main' }],
      }),
      'duplicate session',
    ],
    [
      'duplicate point',
      () => ({
        ...workflow(),
        points: [workflow().points[0], workflow().points[0]],
      }),
      'duplicate point',
    ],
    [
      'duplicate view',
      () => ({
        ...workflow(),
        points: workflow().points.map((point) => ({
          ...point,
          primaryViewId: 'one-view',
        })),
      }),
      'duplicate view',
    ],
    [
      'parent cycle',
      () => ({
        ...workflow(),
        sessions: [{ sessionId: 'main', parentSessionId: 'main' }],
      }),
      'parent session cycle',
    ],
    [
      'relay author confusion',
      () =>
        changeEvent('request', { source: 'parent-relay', role: 'assistant' }),
      'source and role disagree',
    ],
    [
      'approval call missing',
      () => changeEvent('ask-build', { channel: 'approval' }),
      'approval ask must bind',
    ],
    [
      'point cycle',
      () => ({
        ...workflow(),
        points: [
          { ...workflow().points[0], predecessorPointId: 'format-clean' },
        ],
      }),
      'predecessor cycle',
    ],
    [
      'future predecessor',
      () => ({
        ...workflow(),
        points: [
          { ...workflow().points[0], predecessorPointId: 'format-repair' },
          { ...workflow().points[2], predecessorPointId: undefined },
        ],
      }),
      'future predecessor',
    ],
    [
      'unknown relation',
      () => ({
        ...workflow(),
        relations: [
          {
            relationId: 'pair',
            kind: 'controlled',
            pointIds: ['format-clean', 'absent'],
            description: 'comparison',
          },
        ],
      }),
      'unknown relation point',
    ],
  ])('rejects %s with a source location', async (_name, make, message) => {
    const loaded = await loadWorkflow(make());
    expect(problemText(loaded)).toContain(message);
    expect(problemText(loaded)).toContain('dev/f01/workflows.json#/records/0');
    expect(() =>
      selectPointMaterial(loaded, 'format-build', 'format-clean'),
    ).toThrow('invalid grouped dataset');
  });

  it('excludes a logged pending action and its future result, author tags and notes', async () => {
    const loaded = await loadWorkflow();
    const material = selectPointMaterial(
      loaded,
      'format-build',
      'format-build',
    );
    expect(material.history.map((event) => event.eventId)).toEqual([
      'request',
      'scan-call',
      'scan-result',
      'clean-call',
      'clean-result',
      'ask-build',
      'answer-build',
    ]);
    expect(material.pending).toMatchObject({
      callId: 'build',
      arguments: { command: 'pnpm build' },
    });
    const text = JSON.stringify(material);
    for (const hidden of [
      'FUTURE_FAILURE_SENTINEL',
      'AUTHOR_SENTINEL',
      'format-only',
      'provenance',
      'primaryViewId',
    ])
      expect(text).not.toContain(hidden);
    expect(() =>
      selectPointMaterial(loaded, 'format-build', 'unknown'),
    ).toThrow('unknown root/point');
  });

  it('does not invent a result for a call with no observed result', async () => {
    const root = workflow();
    const loaded = await loadWorkflow({
      ...root,
      events: root.events.filter((event) => event.eventId !== 'scan-result'),
      points: [{ ...root.points[0], cutoffEventId: 'scan-call' }],
    });
    expect(loaded.problems).toEqual([]);
    expect(
      selectPointMaterial(loaded, 'format-build', 'format-clean').history.map(
        (event) => event.kind,
      ),
    ).toEqual(['message', 'call']);
  });
});

describe('native identity preservation', () => {
  it('keeps case-sensitive host IDs and uses unambiguous session/call keys', async () => {
    const root = workflow();
    const native = (id: string): string => `Native/${id}`;
    const loaded = await loadWorkflow({
      ...root,
      sessions: [{ sessionId: 'Session/A' }],
      events: root.events.map((event) => ({
        ...event,
        sessionId: 'Session/A',
        eventId: native(event.eventId),
        ...('callId' in event ? { callId: native(event.callId) } : {}),
        ...('askId' in event ? { askId: native(event.askId) } : {}),
      })),
      points: root.points.map((point) => ({
        ...point,
        sessionId: 'Session/A',
        cutoffEventId:
          point.cutoffEventId === null ? null : native(point.cutoffEventId),
        pending:
          'callEventId' in point.pending
            ? { callEventId: native(point.pending.callEventId) }
            : { ...point.pending, callId: native(point.pending.callId) },
      })),
    });
    expect(loaded.problems).toEqual([]);
    expect(
      selectPointMaterial(loaded, root.rootId, 'format-clean').pending.callId,
    ).toBe('Native/clean');
    const collision = await loadWorkflow({
      ...root,
      sessions: [{ sessionId: 'a/b' }, { sessionId: 'a' }],
      events: [
        {
          eventId: 'first',
          sessionId: 'a/b',
          seq: 1,
          turnId: null,
          kind: 'call',
          callId: 'c',
          tool: 'shell',
          arguments: 'ls',
          route: 'bypass',
        },
        {
          eventId: 'second',
          sessionId: 'a',
          seq: 1,
          turnId: null,
          kind: 'result',
          callId: 'b/c',
          status: 'success',
          body: { state: 'empty' },
        },
      ],
      points: [
        {
          pointId: 'collision',
          primaryViewId: 'collision-view',
          sessionId: 'a',
          cutoffEventId: 'second',
          pending: {
            callId: 'next',
            tool: 'shell',
            arguments: 'pwd',
            route: 'reviewer',
          },
        },
      ],
    });
    expect(problemText(collision)).toContain('must exist earlier');
  });
});

describe('per-review parent reads', () => {
  it('permits a parent read after a logged call and prevents future/sibling/tool leakage', async () => {
    const loaded = await loadWorkflow(childWorkflow());
    expect(loaded.problems).toEqual([]);
    const early = selectPointMaterial(
      loaded,
      'format-child',
      'child-first-point',
    );
    expect(early.parent?.events.map((event) => event.eventId)).toEqual([
      'parent-initial',
    ]);
    expect(JSON.stringify(early)).not.toContain('PARENT_FUTURE_SENTINEL');
    expect(JSON.stringify(early)).not.toContain('SIBLING_SENTINEL');
    const later = selectPointMaterial(
      loaded,
      'format-child',
      'child-second-point',
    );
    expect(later.parent?.events.map((event) => event.eventId)).toEqual([
      'parent-initial',
      'parent-new',
    ]);
    expect(later.history[0]).toMatchObject({ source: 'parent-relay' });
  });

  it('distinguishes unreadable and readable empty parent and rejects wrong parent', async () => {
    const root = childWorkflow();
    for (const status of ['complete', 'unavailable'] as const) {
      const loaded = await loadWorkflow({
        ...root,
        points: [
          {
            ...root.points[0],
            parentRead: { sessionId: 'parent', cutoffEventId: null, status },
          },
        ],
      });
      expect(loaded.problems).toEqual([]);
      expect(
        selectPointMaterial(loaded, root.rootId, 'child-first-point').parent,
      ).toEqual({ sessionId: 'parent', status, events: [] });
    }
    const loaded = await loadWorkflow({
      ...root,
      points: [
        {
          ...root.points[0],
          parentRead: {
            sessionId: 'sibling',
            cutoffEventId: 'sibling-message',
            status: 'complete',
          },
        },
      ],
    });
    expect(problemText(loaded)).toContain('direct parent');
  });
});
