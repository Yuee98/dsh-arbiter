import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { REPOSITORY_ROOT } from '../evals/helpers/dataset.js';
import { describe, expect, test } from 'vitest';
import { workflowMaterial } from '../../evals/src/run/material.js';
import { loadWorkflow } from '../evals/helpers/grouped.js';
import { workflow } from '../evals/fixtures/workflow.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { buildReviewSnapshot } from '../../src/snapshot.js';
import type { SessionEventLike } from '../../src/snapshot.js';
import {
  variantPackage,
  PRODUCTION_PACKAGE,
} from '../../src/reviewer/package.js';
import {
  PRODUCTION_VARIANT,
  variantIdFor,
} from '../../src/reviewer/variant.js';
import type { ReviewVariant } from '../../src/reviewer/variant.js';
import { snapshotBasis } from '../../src/host/call-detail-snapshot.js';

const config = {
  ...DEFAULT_CONFIG,
  context: {
    ...DEFAULT_CONFIG.context,
    maxInputTokens: 100_000,
    projectRules: { ...DEFAULT_CONFIG.context.projectRules, enabled: false },
  },
};
const materialOptions = { config, configRevision: 'fixture' };

function variant(
  structure: ReviewVariant['structure'],
  history: ReviewVariant['history'],
): ReviewVariant {
  const axes = { ...PRODUCTION_VARIANT, structure, history };
  return { ...axes, variantId: variantIdFor(axes) };
}

describe('real grouped workflow source -> production material', () => {
  test('CW123-PR-B04 canonical input hashes survive independent process credential keys', async () => {
    const moduleUrl = (path: string) =>
      pathToFileURL(join(REPOSITORY_ROOT, path)).href;
    const source = `import ${JSON.stringify(moduleUrl('evals/src/cli/register.ts'))};
      const {workflowMaterial}=await import(${JSON.stringify(moduleUrl('evals/src/run/material.ts'))});
      const {workflow}=await import(${JSON.stringify(moduleUrl('tests/evals/fixtures/workflow.ts'))});
      const {loadWorkflow}=await import(${JSON.stringify(moduleUrl('tests/evals/helpers/grouped.ts'))});
      const {DEFAULT_CONFIG}=await import(${JSON.stringify(moduleUrl('src/config.ts'))});
      const original=workflow();
      const root={...original,events:original.events.map((event)=>event.eventId==='request'?{...event,content:'password=process-stable-credential; inspect /tmp/output'}:event)};
      const dataset=await loadWorkflow(root,{}, {references:false});
      if(dataset.problems.length) throw new Error('invalid process fixture');
      const config={...DEFAULT_CONFIG,context:{...DEFAULT_CONFIG.context,maxInputTokens:100000,projectRules:{...DEFAULT_CONFIG.context.projectRules,enabled:false}}};
      const material=await workflowMaterial(dataset,root.rootId,'format-clean','chat',{config,configRevision:'fixture'});
      const changed={...root,events:root.events.map((event)=>event.eventId==='request'?{...event,content:'password=another-process-credential; inspect /tmp/output'}:event)};
      const changedDataset=await loadWorkflow(changed,{}, {references:false});
      const different=await workflowMaterial(changedDataset,changed.rootId,'format-clean','chat',{config,configRevision:'fixture'});
      const wire=JSON.stringify(material.request);
      console.log(JSON.stringify({inputHash:material.material.inputHash,changedInputHash:different.material.inputHash,promptFingerprint:material.material.promptFingerprint,rawPresent:wire.includes('process-stable-credential'),markerPresent:wire.includes('[redacted:v1:')}));`;
    const run = async () => {
      const result = await promisify(execFile)(
        process.execPath,
        ['--input-type=module', '--eval', source],
        { cwd: REPOSITORY_ROOT, timeout: 15000 },
      );
      const value: unknown = JSON.parse(result.stdout);
      return value;
    };
    const [first, second] = await Promise.all([run(), run()]);
    expect(first).toMatchObject({ rawPresent: false, markerPresent: true });
    expect(second).toMatchObject({ rawPresent: false, markerPresent: true });
    if (
      first === null ||
      typeof first !== 'object' ||
      second === null ||
      typeof second !== 'object'
    )
      throw new Error('invalid subprocess material');
    expect(Reflect.get(first, 'inputHash')).toBe(
      Reflect.get(second, 'inputHash'),
    );
    expect(Reflect.get(first, 'changedInputHash')).not.toBe(
      Reflect.get(first, 'inputHash'),
    );
    expect(Reflect.get(first, 'changedInputHash')).toBe(
      Reflect.get(second, 'changedInputHash'),
    );
    expect(Reflect.get(first, 'promptFingerprint')).not.toBe(
      Reflect.get(second, 'promptFingerprint'),
    );
  });
  test.each(['chat', 'decision'] as const)(
    'CW123-PR-B02 %s actual workflow request omits MIME-typed binary bodies',
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
                    {
                      type: 'audio/mpeg',
                      encoding: 'base64',
                      data: 'MIME_WIRE_BINARY_SENTINEL',
                      reference: 'audio-ref',
                    },
                  ],
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
        protocol,
        materialOptions,
      );
      const wire = JSON.stringify(material.request);
      expect(wire).not.toContain('MIME_WIRE_BINARY_SENTINEL');
      expect(wire).toContain('audio-ref');
      expect(wire).toContain('omitted');
    },
  );
  test('visible source settlements stay observations without fabricated reviewer traces', async () => {
    const original = workflow();
    const events = original.events.map((event) => ({
      ...event,
      seq: event.seq * 2,
    }));
    events.splice(2, 0, {
      eventId: 'scan-settlement',
      sessionId: 'main',
      seq: 5,
      turnId: 'turn-1',
      kind: 'settlement',
      callId: 'scan',
      outcome: 'allowed',
    });
    const root = { ...original, events };
    const dataset = await loadWorkflow(root);
    expect(dataset.problems).toEqual([]);
    const actual = await workflowMaterial(
      dataset,
      root.rootId,
      'format-clean',
      'chat',
      materialOptions,
    );
    expect(
      actual.snapshot.prefix?.local.events.map((event) => event.kind),
    ).toEqual(['human', 'call', 'settlement', 'result']);
    expect(actual.snapshot.prefix?.local.events[2]).toMatchObject({
      kind: 'settlement',
      outcome: 'allowed',
      seq: 5,
    });
    expect(actual.snapshot.priorVerdicts).toEqual([]);
  });
  test('workflow guidance obeys the same disabled source config and derives action facts through production', async () => {
    const original = workflow();
    const root = {
      ...original,
      events: original.events.map((event) =>
        event.kind === 'call' ? { ...event, tool: 'bash' } : event,
      ),
    };
    const dataset = await loadWorkflow(root);
    const actual = await workflowMaterial(
      dataset,
      root.rootId,
      'format-clean',
      'chat',
      { ...materialOptions, projectRules: 'DISABLED_RULE_SENTINEL' },
    );
    expect(actual.snapshot.projectRules).toBeNull();
    expect(
      actual.snapshot.materials.find((item) => item.id === 'project-rules')
        ?.enabled,
    ).toBe(false);
    expect(JSON.stringify(actual.request)).not.toContain(
      'DISABLED_RULE_SENTINEL',
    );
    expect(actual.snapshot.facts?.parse.status).toBe('ok');
  });
  test.each(['chat', 'decision'] as const)(
    'same prefix facts/identities match the host adapter on %s',
    async (protocol) => {
      const root = workflow({
        task: 'AUTHOR_TASK_SENTINEL',
        notes: 'AUTHOR_NOTES_SENTINEL',
        environment: { cwd: '/fixture' },
      });
      const dataset = await loadWorkflow(root, {}, { references: false });
      expect(dataset.problems).toEqual([]);
      const actual = await workflowMaterial(
        dataset,
        root.rootId,
        'format-clean',
        protocol,
        materialOptions,
      );
      const hostEvents: readonly SessionEventLike[] = [
        {
          eventId: 'request',
          seq: 0,
          type: 'user/message',
          data: {
            turnId: 'turn-1',
            source: { kind: 'user' },
            content: '可以清理生成目录 build/；保留 assets/。',
          },
        },
        {
          eventId: 'scan-call',
          seq: 2,
          type: 'tool/call',
          data: {
            turnId: 'turn-1',
            callId: 'scan',
            name: 'shell',
            arguments: { command: 'ls' },
          },
        },
        {
          eventId: 'scan-result',
          seq: 3,
          type: 'tool/result',
          data: {
            turnId: 'turn-1',
            message: {
              source: { kind: 'tool', callId: 'scan' },
              isError: false,
              content: { entries: ['build/', 'assets/'] },
            },
          },
        },
        {
          eventId: 'clean-call',
          seq: 4,
          type: 'tool/call',
          data: {
            turnId: 'turn-1',
            callId: 'clean',
            name: 'shell',
            arguments: { command: 'rm -rf build/' },
          },
        },
        {
          eventId: 'clean-result',
          seq: 5,
          type: 'tool/result',
          data: {
            message: {
              source: { kind: 'tool', callId: 'clean' },
              isError: false,
              content: 'FUTURE_SENTINEL',
            },
          },
        },
      ];
      const host = await buildReviewSnapshot({
        agent: {
          session: {
            id: 'main',
            inheritedEventCount: 0,
            snapshotEvents: () => hostEvents,
          },
        },
        tool: 'shell',
        arguments: { command: 'rm -rf build/' },
        callId: 'clean',
        cwd: '/fixture',
        config,
        configRevision: 'fixture',
        facts: null,
        priorVerdicts: [],
        sessionRecordGap: null,
      });
      expect(actual.snapshot.prefix?.local.events).toEqual(
        host.snapshot.prefix?.local.events,
      );
      expect(actual.snapshot.prefix?.local.status.cutoff).toEqual(
        host.snapshot.prefix?.local.status.cutoff,
      );
      expect(actual.snapshot.action).toEqual(host.snapshot.action);
      expect(actual.request).toEqual(
        protocol === 'chat'
          ? PRODUCTION_PACKAGE.renderChat(actual.snapshot)
          : PRODUCTION_PACKAGE.renderDecision(actual.snapshot),
      );
      const wire = JSON.stringify(actual.request);
      for (const forbidden of [
        'AUTHOR_TASK_SENTINEL',
        'AUTHOR_NOTES_SENTINEL',
        'FUTURE_SENTINEL',
        'FUTURE_FAILURE_SENTINEL',
      ])
        expect(wire).not.toContain(forbidden);
    },
  );

  test('explicit workflow answer uses its ask identity and future failure is excluded', async () => {
    const dataset = await loadWorkflow();
    const actual = await workflowMaterial(
      dataset,
      'format-build',
      'format-build',
      'chat',
      materialOptions,
    );
    expect(
      actual.snapshot.prefix?.local.events.find(
        (event) => event.eventId === 'answer-build',
      ),
    ).toMatchObject({
      kind: 'human',
      protected: true,
      binding: {
        askId: 'build-question',
        questionEventId: 'ask-build',
        status: 'bound',
      },
    });
    expect(
      actual.snapshot.prefix?.local.events.find(
        (event) => event.eventId === 'ask-build',
      ),
    ).toMatchObject({ protected: true });
    expect(JSON.stringify(actual.request)).not.toContain(
      'FUTURE_FAILURE_SENTINEL',
    );
    expect(
      actual.snapshot.prefix?.local.events.some(
        (event) => event.kind === 'call' && event.callId === 'build',
      ),
    ).toBe(false);
  });

  test.each(['full', 'compact', 'compact-no-audit'] as const)(
    '%s layouts preserve all source facts or explicitly withhold tool history',
    async (structure) => {
      const dataset = await loadWorkflow();
      for (const protocol of ['chat', 'decision'] as const) {
        for (const history of ['current-turn', 'none'] as const) {
          const pkg = variantPackage(variant(structure, history));
          const actual = await workflowMaterial(
            dataset,
            'format-build',
            'format-build',
            protocol,
            { ...materialOptions, pkg },
          );
          const wire = JSON.stringify(actual.request);
          expect(wire).toContain('可以，不要发布。');
          expect(wire).toContain('继续在本地执行构建吗？');
          expect(wire).toContain('answer-build');
          expect(wire).toContain('ask-build');
          expect(wire.includes('withheld')).toBe(history === 'none');
          expect(wire.includes('scan-result')).toBe(history !== 'none');
          expect(wire.includes('clean-result')).toBe(history !== 'none');
          expect(wire).not.toContain('FUTURE_FAILURE_SENTINEL');
        }
      }
    },
  );

  test('unavailable/partial declared parent source cannot masquerade as known empty', async () => {
    for (const status of ['partial', 'unavailable'] as const) {
      const root = workflow({
        sessions: [
          { sessionId: 'parent' },
          { sessionId: 'main', parentSessionId: 'parent' },
        ],
      });
      const changed = {
        ...root,
        points: root.points.map((point) => ({
          ...point,
          parentRead: { sessionId: 'parent', cutoffEventId: null, status },
        })),
      };
      const dataset = await loadWorkflow(changed);
      expect(dataset.problems).toEqual([]);
      const actual = await workflowMaterial(
        dataset,
        root.rootId,
        'format-clean',
        'chat',
        materialOptions,
      );
      expect(actual.snapshot.prefix?.parent?.status.status).toBe(
        status === 'partial' ? 'stopped' : 'unavailable',
      );
      expect(actual.snapshot.parentAuthorizationPresent).toBeNull();
      expect(actual.snapshot.completeness.status).toBe('insufficient');
    }
  });

  test('legacy v1 snapshot remains readable and renders legacy blocks', async () => {
    const dataset = await loadWorkflow();
    const actual = await workflowMaterial(
      dataset,
      'format-build',
      'format-clean',
      'chat',
      materialOptions,
    );
    const { prefix: _prefix, ...legacy } = actual.snapshot;
    expect(snapshotBasis(legacy).evidence).toEqual(actual.snapshot.evidence);
    expect(PRODUCTION_PACKAGE.renderChat(legacy).user).toContain(
      'HUMAN_AUTHORIZATION',
    );
    expect(PRODUCTION_PACKAGE.renderChat(legacy).user).not.toContain(
      'SESSION_TIMELINE',
    );
  });
  test('parent compaction remains known without copying its summary into human evidence', async () => {
    const original = workflow();
    const root = {
      ...original,
      sessions: [
        { sessionId: 'parent' },
        { sessionId: 'main', parentSessionId: 'parent' },
      ],
      events: [
        {
          eventId: 'parent-summary',
          sessionId: 'parent',
          seq: 0,
          turnId: null,
          kind: 'checkpoint' as const,
          content: 'PARENT_SUMMARY_BODY_SENTINEL',
        },
        ...original.events,
      ],
      points: original.points.map((point) => ({
        ...point,
        parentRead: {
          sessionId: 'parent',
          cutoffEventId: 'parent-summary',
          status: 'complete' as const,
        },
      })),
    };
    const dataset = await loadWorkflow(root);
    expect(dataset.problems).toEqual([]);
    const actual = await workflowMaterial(
      dataset,
      root.rootId,
      'format-clean',
      'chat',
      materialOptions,
    );
    expect(actual.snapshot.prefix?.parent?.status.compacted).toBe(true);
    expect(actual.snapshot.parentAuthorizationPresent).toBeNull();
    expect(JSON.stringify(actual.request)).not.toContain(
      'PARENT_SUMMARY_BODY_SENTINEL',
    );
  });
});
