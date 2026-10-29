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

import { act, screen, waitFor } from '@testing-library/react';
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
        approvalMode: 'ask',
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
        reviewState: 'reviewed',
        conflicts: [],
        conflictsTruncated: false,
        scores: null,
        usage: null,
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

    // The attempt is rendered as a flat card section rather than nested disclosures.
    expect(screen.getByText('第 1 次尝试')).toBeInTheDocument();
    expect(screen.getByText('提交的请求')).toBeInTheDocument();
    expect(screen.getByText('模型原文')).toBeInTheDocument();
    // The model's own answer is shown verbatim, as stored.
    const answers = screen.getAllByText(/authorized/u);
    expect(answers.length).toBeGreaterThanOrEqual(1);
    expect(answers[0]?.textContent).toContain('risk');
    // The runtime's own reason is a separate layer, not this answer text.
    expect(answers[0]?.textContent).not.toContain(
      'the review rejected this call',
    );
  });

  test('shows the scored pair and usage without presenting them as the verdict', async () => {
    const body = auditDetailBody();
    body.detail.basis['scores'] = {
      risk: 9,
      authorization: 1,
      requiredAuthorization: 10,
      verdict: 'review-deny',
    };
    body.detail.basis['usage'] = {
      attempts: 1,
      withUsage: 1,
      totals: {
        inputTokens: { total: 900, reported: 1, missing: 0, complete: true },
      },
    };
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });
    await user.click(screen.getByRole('button', { name: '审查结果' }));

    // Both sections are named for what they hold: the score pair is what the
    // reviewer concluded, the usage summary is what the review cost.
    expect(screen.getByRole('region', { name: '两项评分' })).toHaveTextContent(
      'requiredAuthorization',
    );
    expect(screen.getByRole('region', { name: '用量' })).toHaveTextContent(
      'inputTokens',
    );
    // The verdict region stays the review's conclusion; the detail is evidence.
    expect(verdictRegion()).toHaveTextContent('审查拒绝');
    expect(verdictRegion()).not.toHaveTextContent('requiredAuthorization');
  });

  test('says a review happened but its material is gone, not that none ran', async () => {
    const body = auditDetailBody();
    body.detail.source = 'session';
    body.detail.recordFormatVersion = null;
    body.detail.basis['chain'] = null;
    body.detail.basis['reviewState'] = 'reviewed';
    body.detail.raw['modelAttempts'] = [];
    body.detail.basis['evidence'] = [];
    body.detail.basis['materials'] = [];
    body.detail.missing = ['snapshot-missing', 'model-attempts-missing'];
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    // The trace proves a review ran, so the page must not claim it did not.
    expect(
      screen.getByText('这条记录显示曾发出模型请求，但送审证据没有保存。'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('这次调用没有发出模型请求，因此没有送审证据。'),
    ).toBeNull();

    await user.click(
      screen.getByRole('button', { name: '原始材料（默认折叠）' }),
    );
    expect(
      screen.getByText('这条记录显示曾发出模型请求，但模型尝试没有保存。'),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('这次调用没有发出模型请求，因此没有模型尝试。'),
    ).toBeNull();
  });

  test('a pre-request failure is not described as lost attempts', async () => {
    const body = auditDetailBody();
    body.detail.source = 'session';
    body.detail.recordFormatVersion = null;
    body.detail.basis['reviewState'] = 'none';
    body.detail.basis['evidence'] = [];
    body.detail.basis['materials'] = [];
    body.detail.raw['modelAttempts'] = [];
    body.detail.missing = [];
    body.detail.basis['chain'] = [
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
        ts: 1,
      },
      {
        seq: 1,
        stage: 'review',
        result: 'error-escalate',
        reason: 'circuit_open',
        ruleId: null,
        ruleName: null,
        decisionRules: [],
        configRevision: 'rev-1',
        configSnapshotId: 'cfg-1',
        ts: 2,
      },
    ];
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    // The breaker failed before any request, so the page must not say material
    // was lost, and must not claim a rule decided the call.
    expect(
      screen.getByText('这次调用没有发出模型请求，因此没有送审证据。'),
    ).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '原始材料（默认折叠）' }),
    );
    expect(
      screen.getByText('这次调用没有发出模型请求，因此没有模型尝试。'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/送审证据没有保存|模型尝试没有保存/u)).toBeNull();
  });

  test('does not claim a review ran when the record cannot say', async () => {
    const body = auditDetailBody();
    body.detail.source = 'session';
    body.detail.recordFormatVersion = 3;
    body.detail.basis['chain'] = null;
    body.detail.basis['reviewState'] = 'unknown';
    body.detail.basis['trace'] = [];
    body.detail.raw['modelAttempts'] = [];
    body.detail.basis['evidence'] = [];
    body.detail.basis['materials'] = [];
    body.detail.missing = ['stages-missing'];
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    expect(screen.getByText(/无法确认是否发出过模型请求/u)).toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: '原始材料（默认折叠）' }),
    );
    expect(
      screen.getByText(/无法确认是否发出过模型请求，也没有模型尝试记录/u),
    ).toBeInTheDocument();
  });

  test('shows a disputed verdict with both readings instead of one', async () => {
    const body = auditDetailBody();
    body.detail.basis['conflicts'] = [
      { field: 'result', observed: ['deny', 'human-allow'] },
      { field: 'stages[1].reason', observed: ['rule match', 'human approved'] },
    ];
    body.detail.basis['conflictsTruncated'] = true;
    mockDetail(body);
    renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('region', { name: '最终裁决' });

    expect(
      screen.getByText(/两个来源对这次调用的记录不一致/u),
    ).toBeInTheDocument();
    expect(screen.getByText('result', { exact: true })).toBeInTheDocument();
    expect(
      screen.getByText('deny / human-allow', { exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('stages[1].reason', { exact: true }),
    ).toBeInTheDocument();
    expect(screen.getByText(/超出单条记录可表示的范围/u)).toBeInTheDocument();
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
    body.detail.basis['reviewState'] = 'reviewed';
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

describe('call detail localization', () => {
  test('renders the released English catalog with no bare keys', async () => {
    mockDetail(auditDetailBody());
    const { locale } = renderClient(<CallDetailPanel callId="call-1" />, {
      locale: 'en',
    });
    // Since #23 the callDetail module is a declared translation, not a gap: the
    // released English text is what the panel must render.
    await screen.findByRole('region', { name: 'Final verdict' });
    expect(screen.getByText('Basis for the decision')).toBeInTheDocument();
    expect(
      screen.getByRole('group', { name: 'Call overview' }),
    ).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(
      /callDetail\.[a-zA-Z]|undefined|\[object Object\]/u,
    );
    // A stored protocol value is not part of the catalog and stays verbatim.
    expect(document.body.textContent).toContain('R7');

    // Switching the host language rerenders the mounted view in place.
    act(() => {
      locale.setLocale('zh');
    });
    expect(
      screen.getByRole('region', { name: '最终裁决' }),
    ).toBeInTheDocument();
    expect(screen.getByText('判定依据')).toBeInTheDocument();
  });

  test('multi-attempt call allows selecting attempts with aria-pressed buttons and updates evidence', async () => {
    const body = auditDetailBody();
    body.detail.raw['modelAttempts'] = [
      {
        requestId: 'call-1:model:1',
        attempt: 1,
        backend: 'chat',
        protocol: 'arbiter-chat-json-v1',
        templateId: 'tpl-1',
        request: { system: 'prompt 1' },
        responseText: '{"risk":1,"authorized":0}',
        parsed: { risk: 1, authorized: 0 },
        error: null,
        startedAt: 1_700_000_000_002,
        durationMs: 120,
        estimatedInputTokens: 900,
        usage: null,
      },
      {
        requestId: 'call-1:model:2',
        attempt: 2,
        backend: 'chat',
        protocol: 'arbiter-chat-json-v1',
        templateId: 'tpl-2',
        request: { system: 'prompt 2' },
        responseText: '{"risk":9,"authorized":1}',
        parsed: { risk: 9, authorized: 1 },
        error: null,
        startedAt: 1_700_000_000_200,
        durationMs: 150,
        estimatedInputTokens: 950,
        usage: null,
      },
    ];
    mockDetail(body);
    const { user } = renderClient(<CallDetailPanel callId="call-1" />);
    await screen.findByRole('heading', { name: '调用详情 · call-1' });

    // Open raw materials collapsible
    await user.click(screen.getByRole('button', { name: /原始材料/u }));

    // Group of attempts
    const attempt1 = screen.getByRole('button', { name: '第 1 次尝试' });
    const attempt2 = screen.getByRole('button', { name: '第 2 次尝试' });
    expect(attempt1).toHaveAttribute('aria-pressed', 'true');
    expect(attempt2).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/"system": "prompt 1"/u)).toBeInTheDocument();

    // Switch to attempt 2 via click
    await user.click(attempt2);
    expect(attempt1).toHaveAttribute('aria-pressed', 'false');
    expect(attempt2).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/"system": "prompt 2"/u)).toBeInTheDocument();

    // Switch back to attempt 1 via keyboard (Space)
    attempt1.focus();
    await user.keyboard(' ');
    expect(attempt1).toHaveAttribute('aria-pressed', 'true');
    expect(attempt2).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByText(/"system": "prompt 1"/u)).toBeInTheDocument();
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
          limit: 25,
          rows: [
            {
              callId: 'row-1',
              ts: 1_700_000_000_000,
              sessionId: 'session-1',
              sessionKind: 'main',
              tool: 'bash',
              command: 'rm -rf build',
              result: 'deny',
              ruleId: 'no-rm',
              unreadable: false,
            },
          ],
          nextCursor: null,
          prevCursor: null,
          anchor: { ts: 1_700_000_000_000, callId: 'row-1' },
          newer: 0,
          remaining: 0,
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
    // A row is one button whose accessible name is its time, tool, summary and
    // verdict; the whole row opens the detail, so the summary locates it.
    await user.click(
      await screen.findByRole('button', { name: /rm -rf build/u }),
    );

    expect(requested).toEqual(['row-1']);
    expect(
      await screen.findByRole('heading', { name: '调用详情 · row-1' }),
    ).toBeInTheDocument();
    expect(verdictRegion()).toHaveTextContent('审查拒绝');
  });

  test('closing call detail restores focus to log row button', async () => {
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: true,
          total: 1,
          limit: 25,
          rows: [
            {
              callId: 'row-focus',
              ts: 1_700_000_000_000,
              sessionId: 'session-1',
              sessionKind: 'main',
              tool: 'bash',
              command: 'echo hello',
              result: 'allow',
              ruleId: null,
              unreadable: false,
            },
          ],
          nextCursor: null,
          prevCursor: null,
          anchor: { ts: 1_700_000_000_000, callId: 'row-focus' },
          newer: 0,
          remaining: 0,
        }),
      ),
      http.get('*/api/arbiter/log', () => {
        const body = auditDetailBody();
        return HttpResponse.json({
          ok: true,
          detail: { ...body.detail, callId: 'row-focus' },
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    const rowBtn = await screen.findByRole('button', { name: /echo hello/u });
    rowBtn.focus();
    await user.click(rowBtn);

    expect(
      await screen.findByRole('heading', { name: '调用详情 · row-focus' }),
    ).toBeInTheDocument();

    const closeBtn = screen.getByRole('button', { name: '关闭详情' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: '调用详情 · row-focus' }),
      ).toBeNull();
    });
    expect(rowBtn).toHaveFocus();
  });

  test('closing call detail when log row is removed safely falls back to surviving button', async () => {
    server.use(
      http.get('*/api/arbiter/logs', () =>
        HttpResponse.json({
          ok: true,
          total: 1,
          limit: 25,
          rows: [
            {
              callId: 'row-fallback',
              ts: 1_700_000_000_000,
              sessionId: 'session-1',
              sessionKind: 'main',
              tool: 'bash',
              command: 'echo fallback',
              result: 'allow',
              ruleId: null,
              unreadable: false,
            },
          ],
          nextCursor: null,
          prevCursor: null,
          anchor: { ts: 1_700_000_000_000, callId: 'row-fallback' },
          newer: 0,
          remaining: 0,
        }),
      ),
      http.get('*/api/arbiter/log', () => {
        const body = auditDetailBody();
        return HttpResponse.json({
          ok: true,
          detail: { ...body.detail, callId: 'row-fallback' },
        });
      }),
    );
    const { user } = renderClient(<LogsPanel />);
    const rowBtn = await screen.findByRole('button', {
      name: /echo fallback/u,
    });
    await user.click(rowBtn);

    expect(
      await screen.findByRole('heading', { name: '调用详情 · row-fallback' }),
    ).toBeInTheDocument();

    // Disconnect the row
    rowBtn.remove();

    const closeBtn = screen.getByRole('button', { name: '关闭详情' });
    await user.click(closeBtn);

    await waitFor(() => {
      expect(
        screen.queryByRole('heading', { name: '调用详情 · row-fallback' }),
      ).toBeNull();
    });
    expect(screen.getByRole('button', { name: '应用筛选' })).toHaveFocus();
  });
});
