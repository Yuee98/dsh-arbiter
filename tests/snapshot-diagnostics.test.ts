import { describe, expect, test } from 'vitest';
import { estimateTokenCount } from 'tokenx';
import { DEFAULT_CONFIG } from '../src/config.js';
import { prepareReviewSnapshot } from '../src/snapshot.js';
import { renderChatUser, renderDecisionRequest } from '../src/reviewer.js';
import type { HistoryStatus } from '../src/types.js';
import { CredentialRedactor } from '../src/reviewer/credential-redactor.js';
import { redactCompletenessInput } from '../src/snapshot/material-redaction.js';
import {
  buildCompleteness,
  NO_TRIMS,
  type CompletenessInput,
} from '../src/snapshot/completeness.js';

describe('diagnostic material stays safe through budget reconstruction', () => {
  test.each([false, true])(
    'JSON string discovery precedes every sibling projection (reverse=%s)',
    (reverse) => {
      const secret = 'synthetic-json-diagnostic-sibling-secret';
      const diagnostic = JSON.stringify({ password: { value: secret } });
      const value = reverse
        ? { error: diagnostic, note: secret }
        : { note: secret, error: diagnostic };
      const redactor = new CredentialRedactor(
        `json-diagnostic-siblings-${String(reverse)}`,
      );
      const safe = redactor.value(value);
      expect(JSON.stringify(safe)).not.toContain(secret);
      expect(value.note).toBe(secret);
    },
  );
  test('all diagnostic fields share masking without changing completeness roles or counts', () => {
    const secret = 'synthetic-all-diagnostic-private';
    const diagnostic = `password=${secret}; /tmp/output count 4`;
    const input: Omit<CompletenessInput, 'trimmed'> = {
      truncatedHumanEvidence: false,
      protectedEvidenceDropped: [
        { source: 'parent-human', reason: diagnostic },
      ],
      historyTruncated: false,
      sessionReadable: false,
      sessionError: diagnostic,
      parentRequired: true,
      parentReadable: false,
      parentLive: true,
      parentError: diagnostic,
      compaction: false,
      parentCompaction: false,
      projectRules: {
        enabled: true,
        present: false,
        missing: `could not be read: ${diagnostic}`,
      },
      sessionRecordGap: diagnostic,
      historyGap: [diagnostic],
      evidenceCount: 4,
      earlierTurnCalls: 4,
      windowGap: diagnostic,
      hasToolCalls: true,
    };
    const redactor = new CredentialRedactor('all-diagnostics', [
      'could not be read',
      'parent-human',
      '4',
    ]);
    redactor.discover(input);
    const safe = redactCompletenessInput(input, redactor);
    expect(JSON.stringify(safe)).not.toContain(secret);
    expect(safe.protectedEvidenceDropped[0]?.source).toBe('parent-human');
    expect(safe.evidenceCount).toBe(4);
    expect(safe.earlierTurnCalls).toBe(4);
    const before = buildCompleteness({ ...input, trimmed: NO_TRIMS });
    const after = buildCompleteness({ ...safe, trimmed: NO_TRIMS });
    const roles = (value: typeof before) =>
      value.items.map(({ source, kind, blocking }) => ({
        source,
        kind,
        blocking,
      }));
    expect(roles(after)).toEqual(roles(before));
    expect(after.status).toBe(before.status);
    expect(input.projectRules.missing).toContain(secret);
  });
  test('a credential first labelled only in history-source diagnostics masks earlier material', async () => {
    const secret = 'synthetic-source-only-diagnostic';
    const diagnostic = JSON.stringify({ password: { value: secret } });
    const history: HistoryStatus = {
      coverage: 'partial',
      windowTruncated: false,
      reason: 'audit read unavailable',
      reset: false,
      sources: {
        memory: { read: 4, unavailable: null },
        session: { read: 0, unavailable: null },
        audit: { read: 0, unavailable: diagnostic },
      },
    };
    const args = { command: `echo ${secret}` };
    const preparation = await prepareReviewSnapshot({
      agent: {
        session: { id: 'history-source-diagnostic', snapshotEvents: () => [] },
      },
      tool: 'bash',
      arguments: args,
      callId: 'history-source-diagnostic',
      cwd: '/tmp',
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          projectRules: {
            ...DEFAULT_CONFIG.context.projectRules,
            enabled: false,
          },
        },
      },
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      historyStatus: history,
      configRevision: 'test',
    });
    expect(JSON.stringify(preparation.bundle.snapshot)).not.toContain(secret);
    expect(preparation.bundle.user).not.toContain(secret);
    expect(preparation.bundle.snapshot.historyStatus.sources.memory.read).toBe(
      4,
    );
    expect(args.command).toContain(secret);
    expect(history.sources.audit.unavailable).toBe(diagnostic);
  });
  test.each(
    (['session', 'parent', 'record', 'history'] as const).flatMap((source) =>
      (['assignment', 'json', 'encoded'] as const).map((format) => ({
        source,
        format,
      })),
    ),
  )(
    '$source/$format diagnostics are safe before source caps and credential-finalized builds',
    async ({ source, format }) => {
      const secret = `synthetic-${source}-${format}-diagnostic-${'private'.repeat(16)}-tail`;
      const json = JSON.stringify({
        password: { value: secret },
        path: '/tmp/output',
        recipient: 'ops@example.test',
        count: 4,
      });
      const diagnostic =
        format === 'assignment'
          ? `password=${secret}; inspect /tmp/output for ops@example.test, count 4`
          : format === 'json'
            ? json
            : JSON.stringify(json);
      const history: HistoryStatus = {
        coverage: 'partial',
        windowTruncated: false,
        reason: diagnostic,
        sources: {
          memory: { read: 0, unavailable: diagnostic },
          session: { read: 0, unavailable: diagnostic },
          audit: { read: 0, unavailable: diagnostic },
        },
        reset: false,
      };
      const fail = () => {
        throw new Error(diagnostic);
      };
      const session = {
        id: `diagnostic-${source}`,
        header: source === 'parent' ? { parentSession: 'parent' } : {},
        snapshotEvents:
          source === 'session'
            ? fail
            : () => [
                {
                  type: 'user/message',
                  seq: 1,
                  data: {
                    source: { kind: 'user', rpcId: 'diagnostic-user' },
                    content: [
                      { type: 'text', text: `${'x'.repeat(3968)}${secret}` },
                    ],
                  },
                },
              ],
      };
      const args = {
        command: `echo ${'ordinary '.repeat(2000)}`,
        note: secret,
      };
      const preparation = await prepareReviewSnapshot({
        agent: { session },
        sessions: { get: () => ({ id: 'parent', snapshotEvents: fail }) },
        tool: 'bash',
        arguments: args,
        callId: `diagnostic-${source}`,
        cwd: '/tmp',
        config: {
          ...DEFAULT_CONFIG,
          context: {
            ...DEFAULT_CONFIG.context,
            maxInputTokens: 4000,
            customRules: `${'x'.repeat(1968)}${secret}`,
            projectRules: {
              ...DEFAULT_CONFIG.context.projectRules,
              enabled: false,
            },
          },
        },
        facts: null,
        priorVerdicts: [],
        sessionRecordGap: source === 'record' ? diagnostic : null,
        ...(source === 'history' ? { historyStatus: history } : {}),
        configRevision: 'diagnostic-test',
      });
      for (const built of [
        preparation.bundle,
        preparation.rebuild(['synthetic-selected-auth']),
      ]) {
        expect(JSON.stringify(built.snapshot)).not.toContain(secret);
        expect(built.user).not.toContain(secret);
        expect(JSON.stringify(built.snapshot)).not.toContain(
          secret.slice(0, 32),
        );
        expect(built.snapshot.missing.join(' ')).toContain('[redacted:v1:');
        expect(built.snapshot.missing.join(' ')).toContain('/tmp/output');
        expect(built.snapshot.budget.truncatedSegments).toContain('ACTION');
        expect(built.user).toBe(renderChatUser(built.snapshot));
        const decision = renderDecisionRequest(built.user);
        expect(built.estimatedInputTokens).toBe(
          Math.max(
            estimateTokenCount(built.system) + estimateTokenCount(built.user),
            decision.estimatedInputTokens,
          ),
        );
      }
      expect(args.command).toBe(`echo ${'ordinary '.repeat(2000)}`);
      expect(args.note).toBe(secret);
      expect(history.sources.audit.unavailable).toBe(diagnostic);
    },
  );
});
