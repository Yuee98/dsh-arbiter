import { describe, expect, test, vi } from 'vitest';
import { prepareReviewSnapshot } from '../src/snapshot.js';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { DEFAULT_CONFIG } from '../src/config.js';
import { workflowMaterial } from '../evals/src/run/material.js';
import { loadWorkflow } from './evals/helpers/grouped.js';
import { workflow, collectionOf } from './evals/fixtures/workflow.js';

const config = {
  ...DEFAULT_CONFIG,
  context: {
    ...DEFAULT_CONFIG.context,
    maxInputTokens: 100_000,
    projectRules: { ...DEFAULT_CONFIG.context.projectRules, enabled: false },
  },
};
const input = {
  tool: 'bash',
  arguments: { command: 'echo action' },
  callId: 'pending',
  cwd: '/fixture',
  config,
  facts: null,
  priorVerdicts: [],
  sessionRecordGap: null,
  configRevision: 'fixture',
};

describe('new event material shares captured credential preparation', () => {
  test.each(['chat', 'decision'] as const)(
    'workflow %s results redact split credentials while preserving source block tags',
    async (protocol) => {
      const original = workflow();
      const root = {
        ...original,
        events: original.events.map((event) =>
          event.kind === 'result' && event.eventId === 'scan-result'
            ? {
                ...event,
                body: {
                  state: 'present' as const,
                  content: [
                    { type: 'text', text: 'password=split-workflow-' },
                    { type: 'text', text: 'credential; path=/tmp/output' },
                  ],
                },
              }
            : event.eventId === 'request'
              ? { ...event, content: 'split-workflow-' }
              : event,
        ),
      };
      const dataset = await loadWorkflow(root, {}, { references: false });
      expect(dataset.problems).toEqual([]);
      const material = await workflowMaterial(
        dataset,
        root.rootId,
        'format-clean',
        protocol,
        { config, configRevision: 'fixture', credentialValues: ['text'] },
      );
      expect(material.snapshot.prefix?.local.events[0]).toMatchObject({
        kind: 'human',
        text: 'split-workflow-',
      });
      const result = material.snapshot.prefix?.local.events.find(
        (event) => event.kind === 'result',
      );
      expect(result?.kind === 'result' && result.body).toMatchObject({
        state: 'present',
        content: [{ type: 'text' }, { type: 'text' }],
      });
      expect(JSON.stringify(result)).not.toContain('split-workflow-');
      expect(JSON.stringify(result)).not.toContain('credential;');
      expect(JSON.stringify(result)).toContain('/tmp/output');
    },
  );
  test('evaluating a later point first cannot lend future credential vocabulary to an earlier point', async () => {
    const original = workflow();
    const root = {
      ...original,
      events: original.events.map((event) =>
        event.eventId === 'request'
          ? { ...event, content: 'bare-future-vocabulary' }
          : event.kind === 'result' && event.eventId === 'scan-result'
            ? {
                ...event,
                body: {
                  state: 'present' as const,
                  content: { password: 'bare-future-vocabulary' },
                },
              }
            : event,
      ),
      points: [
        {
          pointId: 'early',
          primaryViewId: 'early-view',
          sessionId: 'main',
          cutoffEventId: 'request',
          pending: {
            callId: 'early-action',
            tool: 'shell',
            arguments: { command: 'echo early' },
            route: 'reviewer' as const,
          },
        },
        ...original.points,
      ],
    };
    const dataset = await loadWorkflow(root, {}, { references: false });
    expect(dataset.problems).toEqual([]);
    await workflowMaterial(dataset, root.rootId, 'format-clean', 'chat', {
      config,
      configRevision: 'fixture',
    });
    const early = await workflowMaterial(
      dataset,
      root.rootId,
      'early',
      'chat',
      { config, configRevision: 'fixture' },
    );
    expect(early.snapshot.prefix?.local.events[0]).toMatchObject({
      kind: 'human',
      text: 'bare-future-vocabulary',
    });
  });
  test('workflow oversized results use the same nonblocking source protection as host results', async () => {
    const original = workflow();
    const root = {
      ...original,
      events: original.events.map((event) =>
        event.kind === 'result' && event.eventId === 'scan-result'
          ? {
              ...event,
              body: {
                state: 'present' as const,
                content: 'x'.repeat(16 * 1024 * 1024 + 1),
              },
            }
          : event,
      ),
    };
    const dataset = await loadWorkflow(root, {}, { references: false });
    expect(dataset.problems).toEqual([]);
    const material = await workflowMaterial(
      dataset,
      root.rootId,
      'format-clean',
      'chat',
      { config, configRevision: 'fixture' },
    );
    expect(material.snapshot.prefix?.local.status.status).toBe('stopped');
    expect(material.snapshot.prefix?.local.status.cutoff?.eventId).toBe(
      'scan-result',
    );
    expect(
      material.snapshot.prefix?.local.events.some(
        (event) => event.kind === 'human',
      ),
    ).toBe(true);
    expect(material.snapshot.completeness.gaps).toEqual([]);
  });
  test('ordinary oversized result stops the read before redaction without losing the protected human', async () => {
    const events = [
      {
        seq: 0,
        type: 'user/message',
        data: { source: { kind: 'user' }, content: 'Only local work' },
      },
      {
        seq: 1,
        type: 'tool/call',
        data: {
          callId: 'huge',
          name: 'bash',
          arguments: { command: 'echo large' },
        },
      },
      {
        seq: 2,
        type: 'tool/result',
        data: {
          message: {
            source: { kind: 'tool', callId: 'huge' },
            isError: false,
            content: 'x'.repeat(16 * 1024 * 1024 + 1),
          },
        },
      },
    ];
    const prepared = await prepareReviewSnapshot(
      {
        ...input,
        agent: {
          session: {
            id: 'large-read',
            inheritedEventCount: 0,
            snapshotEvents: () => events,
          },
        },
      },
      new CredentialRedactor('large-read'),
    );
    expect(prepared.bundle.snapshot.prefix?.local.status.status).toBe(
      'stopped',
    );
    expect(prepared.bundle.snapshot.prefix?.local.status.cutoff?.seq).toBe(2);
    expect(prepared.bundle.user).toContain('Only local work');
    expect(prepared.bundle.snapshot.completeness.gaps).toEqual([]);
    expect(
      prepared.bundle.snapshot.completeness.items.some(
        (item) =>
          item.kind === 'known-empty' && item.source === 'session-human',
      ),
    ).toBe(false);
  });
  test('future credential definitions do not influence the earlier visible prefix', async () => {
    const events = [
      {
        seq: 0,
        type: 'user/message',
        data: { source: { kind: 'user' }, content: 'visible-unlabelled-value' },
      },
      {
        seq: 1,
        type: 'tool/call',
        data: {
          callId: 'pending',
          name: 'bash',
          arguments: { command: 'echo action' },
        },
      },
      {
        seq: 2,
        type: 'user/message',
        data: {
          source: { kind: 'user' },
          content: 'password=visible-unlabelled-value FUTURE_DEFINITION',
        },
      },
    ];
    const prepared = await prepareReviewSnapshot(
      {
        ...input,
        agent: {
          session: {
            id: 'cutoff',
            inheritedEventCount: 0,
            snapshotEvents: () => events,
          },
        },
      },
      new CredentialRedactor('cutoff-source'),
    );
    expect(prepared.bundle.user).toContain('visible-unlabelled-value');
    expect(prepared.bundle.user).not.toContain('FUTURE_DEFINITION');
    expect(prepared.bundle.user).not.toContain('[redacted:');
  });
  test('late-known rebuild preserves captured local, parent, action and timestamp exactly', async () => {
    const localData = {
      source: { kind: 'user' },
      content: 'Only local ' + 'opaque-local-value',
    };
    const parentData = { source: { kind: 'user' }, content: 'parent-original' };
    const local = [{ seq: 0, type: 'user/message', data: localData }];
    const parent = [{ seq: 0, type: 'user/message', data: parentData }];
    const readLocal = vi.fn(() => local);
    const readParent = vi.fn(() => parent);
    const args = { command: 'echo original-action opaque-local-value' };
    const prepared = await prepareReviewSnapshot(
      {
        ...input,
        arguments: args,
        agent: {
          session: {
            id: 'child',
            header: { parentSession: 'parent' },
            inheritedEventCount: 0,
            snapshotEvents: readLocal,
          },
        },
        sessions: {
          get: () => ({
            id: 'parent',
            inheritedEventCount: 0,
            snapshotEvents: readParent,
          }),
        },
      },
      new CredentialRedactor('same-capture'),
    );
    localData.content = 'MUTATED_LOCAL';
    parentData.content = 'MUTATED_PARENT';
    args.command = 'MUTATED_ACTION';
    local.push({
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: 'FUTURE_LOCAL' },
    });
    parent.push({
      seq: 1,
      type: 'user/message',
      data: { source: { kind: 'user' }, content: 'FUTURE_PARENT' },
    });
    const rebuilt = prepared.rebuild(['opaque-local-value']);
    expect(readLocal).toHaveBeenCalledTimes(1);
    expect(readParent).toHaveBeenCalledTimes(1);
    expect(rebuilt.snapshot.createdAt).toBe(prepared.bundle.snapshot.createdAt);
    expect(
      rebuilt.snapshot.prefix?.local.events.map((event) => event.seq),
    ).toEqual([0]);
    expect(
      rebuilt.snapshot.prefix?.parent?.events.map((event) => event.seq),
    ).toEqual([0]);
    expect(rebuilt.user).not.toMatch(/MUTATED|FUTURE|opaque-local-value/u);
    expect(rebuilt.user).toContain('parent-original');
    expect(rebuilt.user).toContain('original-action');
  });
  test('workflow views reuse policy and scope without leaking across roots with repeated session names', async () => {
    const make = (rootId: string) => {
      const original = workflow();
      return {
        ...original,
        rootId,
        events: original.events.map((event) => ({
          ...event,
          eventId: rootId + '-' + event.eventId,
          ...(event.kind === 'message' && event.source === 'human'
            ? { content: 'bare-credential-value' }
            : {}),
        })),
        points: original.points.map((point) => ({
          ...point,
          pointId: rootId + '-' + point.pointId,
          primaryViewId: rootId + '-' + point.primaryViewId,
          cutoffEventId:
            point.cutoffEventId === null
              ? null
              : rootId + '-' + point.cutoffEventId,
          pending:
            'callEventId' in point.pending
              ? { callEventId: rootId + '-' + point.pending.callEventId }
              : point.pending,
          ...(point.predecessorPointId === undefined
            ? {}
            : { predecessorPointId: rootId + '-' + point.predecessorPointId }),
        })),
      };
    };
    const first = make('root-a');
    const second = make('root-b');
    const dataset = await loadWorkflow(
      first,
      { 'dev/f02/workflows.json': collectionOf(second) },
      { references: false },
    );
    expect(dataset.problems).toEqual([]);
    const opts = {
      config,
      configRevision: 'fixture',
      credentialValues: ['bare-credential-value'],
    };
    const chat = await workflowMaterial(
      dataset,
      'root-a',
      'root-a-format-clean',
      'chat',
      opts,
    );
    const decision = await workflowMaterial(
      dataset,
      'root-a',
      'root-a-format-clean',
      'decision',
      opts,
    );
    const other = await workflowMaterial(
      dataset,
      'root-b',
      'root-b-format-clean',
      'chat',
      opts,
    );
    const markers = (value: unknown) =>
      new Set(JSON.stringify(value).match(/\[redacted:v1:[^\]]+\]/gu));
    expect(JSON.stringify(chat.request)).not.toContain('bare-credential-value');
    expect(markers(chat.snapshot.prefix)).toEqual(
      markers(decision.snapshot.prefix),
    );
    expect(markers(chat.snapshot.prefix).size).toBeGreaterThan(0);
    expect(markers(chat.snapshot.prefix)).not.toEqual(
      markers(other.snapshot.prefix),
    );
    expect(first.events[0]).toMatchObject({ content: 'bare-credential-value' });
  });
});
