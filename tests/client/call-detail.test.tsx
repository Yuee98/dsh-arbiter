/**
 * The shared call detail, driven through the real page.
 *
 * What is pinned here:
 *   - the final verdict and its reason are rendered before any other overview
 *     fact, so the answer is readable without scanning the panel;
 *   - the three layers are present and the raw materials start collapsed;
 *   - a historical rule name comes from the stored stage, not from the live rule
 *     list — the test seeds a differently named live rule to prove it;
 *   - a partial (session-sourced) detail states what is missing instead of
 *     rendering empty sections;
 *   - the permission verdict and the host execution result are never presented
 *     as the same value;
 *   - a call no source holds renders the "record unavailable" sentence, not an
 *     empty detail.
 */

import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';
import { CallDetailPanel } from '../../src/client/components/call-detail-panel.js';
import { LogsPanel } from '../../src/client/panels/logs.js';

const server = setupApiMock();

/** One section of the wire detail, mutable for a case that changes a field. */
type Section = Record<string, unknown>;

/** The detail body as the mock serves it. */
interface DetailBody {
  readonly ok: boolean;
  readonly detail: DetailFixture;
}

interface DetailFixture {
  callId: string;
  source: string;
  recordFormatVersion: number | null;
  unreadable: boolean;
  unreadableReason: string | null;
  overview: Section;
  basis: Section;
  raw: Section;
  missing: string[];
  missingUnknown: number;
}

/** A stored audit detail, shaped exactly as the host route returns it. */
function auditDetailBody(): DetailBody {
  return {
    ok: true,
    detail: {
      callId: 'call-1',
      source: 'audit',
      recordFormatVersion: 2,
      unreadable: false,
      unreadableReason: null,
      overview: {
        tool: 'bash',
        ts: 1_700_000_000_000,
        sessionId: 'session-1',
        sessionKind: 'main',
        parentSession: null,
        workspace: '/workspace/app',
        cwd: '/workspace/app',
        profile: 'default',
        approvalMode: 'normal',
        executionMode: 'guarded',
        verdict: 'review-deny',
        verdictReason: 'the review rejected this call',
        configRevision: 'rev-1',
        fingerprint: 'bash:abc',
        execution: {
          status: 'not-started',
          startedAt: null,
          finishedAt: null,
        },
        cancelled: false,
      },
      basis: {
        rule: null,
        decisionRules: ['R7'],
        policyStrategy: 'normal',
        chain: [
          {
            seq: 0,
            stage: 'rule',
            result: 'review(default)',
            reason: null,
            ruleId: null,
            ruleName: null,
            decisionRules: [],
            configRevision: 'rev-1',
            configSnapshotId: 'cfg-1',
            ts: 1_700_000_000_001,
          },
          {
            seq: 1,
            stage: 'review',
            result: 'review-deny',
            reason: 'risk too high',
            ruleId: null,
            ruleName: null,
            decisionRules: ['R7'],
            configRevision: 'rev-1',
            configSnapshotId: 'cfg-1',
            ts: 1_700_000_000_002,
          },
        ],
        trace: ['review(default)', 'review-deny'],
        reviewed: true,
        signals: null,
        evidence: [
          {
            ts: 1_700_000_000_000,
            source: { kind: 'session-human', sessionId: 'session-1' },
            role: 'human-instruction',
            evidence: 'explicit',
            text: 'deploy to staging',
          },
        ],
        materials: [{ id: 'custom-rules', enabled: true, present: true }],
        evidenceTruncated: false,
        snapshotMissing: [],
        historyStatus: null,
        effect: null,
      },
      raw: {
        arguments: { command: 'rm -rf build' },
        argumentsSchema: null,
        snapshot: { version: 1 },
        config: { enabled: true },
        configFormatVersion: 1,
        snapshotFormatVersion: 1,
        modelAttempts: [
          {
            requestId: 'call-1:model:1',
            attempt: 1,
            backend: 'chat',
            protocol: 'arbiter-chat-json-v1',
            templateId: 'tpl-1',
            request: { system: 'review this' },
            responseText: '{"risk":9,"authorized":1}',
            parsed: { risk: 9, authorized: 1 },
            error: null,
            startedAt: 1_700_000_000_002,
            durationMs: 120,
            estimatedInputTokens: 900,
            usage: null,
          },
        ],
        templates: [],
        sessionRecordState: 'written',
      },
      missing: [],
      missingUnknown: 0,
    },
  };
}

function mockDetail(body: DetailBody): void {
  server.use(
    http.get('*/api/arbiter/log', ({ request }) => {
      const callId = new URL(request.url).searchParams.get('callId') ?? '';
      return HttpResponse.json({
        ok: true,
        detail: { ...body.detail, callId },
      });
    }),
  );
}

/** The verdict region, found by its accessible name. */
function verdictRegion(): HTMLElement {
  return screen.getByRole('region', { name: '最终裁决' });
}

/** The overview group, found by its accessible name. */
function overviewGroup(): HTMLElement {
  return screen.getByRole('group', { name: '调用概览' });
}

describe('shared call detail', () => {
  test('renders the final verdict before the other overview facts', async () => {
    mockDetail(auditDetailBody());
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    const verdict = verdictRegion();
    expect(verdict).toHaveTextContent('审查拒绝');
    expect(verdict).toHaveTextContent('the review rejected this call');

    // The overview groups the verdict; the basis and raw layers are later.
    const overview = overviewGroup();
    expect(overview).toContainElement(verdict);
    const basis = screen.getByText('判定依据');
    const raw = screen.getByRole('button', { name: '原始材料（默认折叠）' });
    expect(
      overview.compareDocumentPosition(basis) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      basis.compareDocumentPosition(raw) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test('keeps the three layers and starts raw material collapsed', async () => {
    mockDetail(auditDetailBody());
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    expect(screen.getByText('判定依据')).toBeInTheDocument();
    // The raw layer is a real disclosure: its content is not mounted while shut.
    const raw = screen.getByRole('button', { name: '原始材料（默认折叠）' });
    expect(raw).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('工具输入')).toBeNull();
    expect(screen.queryByText(/模型尝试（1）/u)).toBeNull();
  });

  test('shows the attempt, its request and the model text separately', async () => {
    mockDetail(auditDetailBody());
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });
    await user.click(
      screen.getByRole('button', { name: '原始材料（默认折叠）' }),
    );

    // The attempt is its own disclosure; opening it reveals the material.
    const attempt = screen.getByRole('button', { name: '第 1 次尝试' });
    expect(attempt).toHaveAttribute('aria-expanded', 'false');
    await user.click(attempt);
    expect(
      screen.getByRole('button', { name: '提交的请求' }),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '模型原文' }));
    // The model's own answer is shown verbatim, as stored.
    const answer = screen.getByText(/authorized/u);
    expect(answer.textContent).toContain('risk');
    // The runtime's own reason is a separate layer, not this answer text.
    expect(answer.textContent).not.toContain('the review rejected this call');
  });

  test('shows the policy signals without presenting them as the verdict', async () => {
    const body = auditDetailBody();
    body.detail.basis['signals'] = {
      riskPoint: 9,
      authPoint: 1,
      riskClass: 'high',
    };
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });
    await user.click(screen.getByRole('button', { name: '信号与阈值' }));

    const signals = screen.getByRole('region', { name: '信号与阈值' });
    expect(signals).toHaveTextContent('riskPoint');
    // The verdict region stays the review's conclusion; signals are evidence.
    expect(verdictRegion()).toHaveTextContent('审查拒绝');
    expect(verdictRegion()).not.toHaveTextContent('riskPoint');
  });

  test('uses the historical rule name rather than the live rule list', async () => {
    server.use(
      http.get('*/api/arbiter/state', () =>
        HttpResponse.json(effectiveState()),
      ),
    );
    const body = auditDetailBody();
    body.detail.basis['rule'] = {
      ruleId: 'no-rm',
      ruleName: 'Block recursive delete',
    };
    mockDetail(body);
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });
    // The stored name is rendered even though the live rule list has no such
    // rule, so the name cannot have come from the current configuration.
    expect(screen.getByText('Block recursive delete')).toBeInTheDocument();
    expect(screen.getByText('no-rm')).toBeInTheDocument();
  });

  test('a partial session record names what is missing', async () => {
    const body = auditDetailBody();
    body.detail.source = 'session';
    body.detail.recordFormatVersion = null;
    body.detail.overview['approvalMode'] = null;
    body.detail.overview['execution'] = {
      status: null,
      startedAt: null,
      finishedAt: null,
    };
    body.detail.basis['chain'] = null;
    body.detail.basis['trace'] = ['review-deny'];
    body.detail.raw['modelAttempts'] = [];
    body.detail.missing = [
      'audit-record-cleared',
      'stage-details-missing',
      'snapshot-missing',
      'model-attempts-missing',
    ];
    mockDetail(body);
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    expect(screen.getByText(/详细审计记录不可用/u)).toBeInTheDocument();
    const missing = screen.getByRole('group', { name: '材料缺失' });
    expect(missing).toHaveTextContent('审计中没有这条记录');
    expect(missing).toHaveTextContent('只保存了阶段结果');
    expect(missing).toHaveTextContent('没有保存审查快照');
    // The chain states that only results were stored, and invents no stage.
    expect(
      screen.getByText('只记录了阶段结果，未保存各阶段名称与原因：'),
    ).toBeInTheDocument();
    // Approval mode was not recorded; "unknown" is shown, not a blank.
    expect(screen.getAllByText('未知').length).toBeGreaterThan(0);
  });

  test('does not present the execution result as the permission verdict', async () => {
    const body = auditDetailBody();
    body.detail.overview['execution'] = {
      status: 'failed',
      startedAt: 1_700_000_000_010,
      finishedAt: 1_700_000_000_020,
    };
    mockDetail(body);
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    // The permission verdict is the review's denial …
    expect(verdictRegion()).toHaveTextContent('审查拒绝');
    expect(verdictRegion()).not.toHaveTextContent('执行失败');
    // … while the host's failure is its own labelled fact.
    const row = screen.getByRole('row', { name: /执行结果/u });
    expect(row).toHaveTextContent('执行失败');
    expect(row).toHaveTextContent('不是权限裁决');
  });

  test('reports a record no source holds instead of an empty detail', async () => {
    server.use(
      http.get('*/api/arbiter/log', () =>
        HttpResponse.json(
          { ok: false, code: 'record-unavailable' },
          { status: 404 },
        ),
      ),
    );
    renderClient(<CallDetailPanel callId="gone" />);
    expect(await screen.findByText(/没有找到这条调用/u)).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: '最终裁决' })).toBeNull();
  });

  test('renders an unreadable stored format without reinterpreting it', async () => {
    const body = auditDetailBody();
    body.detail.unreadable = true;
    body.detail.recordFormatVersion = 99;
    body.detail.unreadableReason =
      'record format 99 is newer than this plugin (2)';
    body.detail.overview['verdict'] = null;
    body.detail.missing = ['record-format-newer'];
    mockDetail(body);
    renderClient(<CallDetailPanel callId="call-1" />);

    expect(
      await screen.findByText(/存储格式高于当前插件版本/u),
    ).toBeInTheDocument();
    // The layers are not rendered from a shape this build cannot interpret.
    expect(screen.queryByText('判定依据')).toBeNull();
    expect(
      screen.queryByRole('button', { name: '原始材料（默认折叠）' }),
    ).toBeNull();
    expect(screen.getByText(/记录格式高于当前插件版本/u)).toBeInTheDocument();
  });
});

describe('the log list entry', () => {
  test('opens the shared detail for the row call id', async () => {
    const requested: string[] = [];
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: true,
          total: 1,
          rows: [
            {
              callId: 'row-1',
              ts: 1_700_000_000_000,
              sessionId: 'session-1',
              sessionKind: 'main',
              tool: 'bash',
              command: 'rm -rf build',
              result: 'deny',
              reason: 'blocked by a rule',
              ruleId: 'no-rm',
              approvalMode: 'normal',
              decisionRules: [],
            },
          ],
        }),
      ),
      http.get('*/api/arbiter/log', ({ request }) => {
        const callId = new URL(request.url).searchParams.get('callId') ?? '';
        requested.push(callId);
        const body = auditDetailBody();
        return HttpResponse.json({
          ok: true,
          detail: { ...body.detail, callId },
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    await user.click(await screen.findByRole('button', { name: '查看详情' }));

    expect(requested).toEqual(['row-1']);
    expect(
      await screen.findByRole('heading', { name: '调用详情 · row-1' }),
    ).toBeInTheDocument();
    expect(verdictRegion()).toHaveTextContent('审查拒绝');
  });
});
