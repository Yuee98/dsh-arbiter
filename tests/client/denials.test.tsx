/**
 * The session denial row (#19), driven through the real components.
 *
 * What is pinned here, in the words of the acceptance criteria:
 *   - every refusal source renders its own sentence, and only a real human
 *     refusal says the user rejected the call;
 *   - a rule denial, a review denial, a fallback and an abandoned question are
 *     distinguishable rather than collapsed into one "denied";
 *   - a bounded reason states that it was shortened;
 *   - a record with no reason still explains the minimum verdict instead of
 *     rendering an empty row;
 *   - the detail entry opens #17's shared `CallDetailPanel` for the same callId;
 *   - a call Arbiter allowed whose body then failed in the host sandbox renders
 *     no Arbiter denial at all;
 *   - a refusal raises no toast or modal.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { setupApiMock } from '../helpers/api-mock.js';
import { renderClient } from '../helpers/render-client.js';
import {
  ARBITER_DENIED_CODE,
  ARBITER_DENIED_ERROR_NAME,
  denialOf,
} from '../../src/client/decoders/denials.js';
import { DenialRow } from '../../src/client/components/denial-row.js';
import {
  createDenialNodeView,
  denialDefinition,
  DENIAL_NODE_KIND,
} from '../../src/client/components/denial-node.js';
import { createArbiterI18n } from '../../src/client/i18n.js';
import { createTestLocale } from '../helpers/test-locale.js';
import type { ArbiterDenialView } from '../../src/client/view-types.js';

const server = setupApiMock();

/** The agent-facing text a rule denial really produces (`feedback.ts`). */
const RULE_REASON =
  'Not executed [deny-rule]: a deny rule matched this call (rule "no-rm"). The rule is deterministic; changing the command does not bypass it. Ask the user about the intended action or use an allowed alternative.';

/** The text a review denial really produces. */
const REVIEW_REASON =
  'Not executed [review-deny]: the review denied this call (review rule R3): no sufficient authorization was found. Try a narrower action, or ask the user for the authorization or information the review could not confirm.';

/** The text an unavailable approval channel really produces. */
const FALLBACK_REASON =
  'Not executed [fallback-deny]: this call requires human approval, but the selected mode does not open approval requests. Cause: automatic_mode_no_human. This mode does not open approvals, so the call was not executed.';

/** The text a person's refusal really produces. */
const HUMAN_REASON =
  'Not executed [human-deny]: the user rejected this call. Do not retry the same call. Ask the user what they want instead.';

/** The text an abandoned question really produces. */
const ABORT_REASON =
  'Not executed [human-abort]: the approval ended without a grant or a denial. Cause: the question was cancelled. The user did not decide. Ask again or request a narrower action; a new call is reviewed from the start.';

/** One `tool/result` event exactly as the host records an Arbiter denial. */
function arbiterResult(options: {
  readonly callId: string;
  readonly tool: string;
  readonly reason?: string | null;
  readonly name?: string;
  readonly code?: string;
}): Record<string, unknown> {
  return {
    type: 'tool/result',
    seq: 7,
    time: 1_700_000_000_000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'tool',
        toolCallId: options.callId,
        source: { callId: options.callId, name: options.tool },
        isError: true,
      },
      ...(options.reason === null
        ? {}
        : {
            error: {
              name: options.name ?? ARBITER_DENIED_ERROR_NAME,
              code: options.code ?? ARBITER_DENIED_CODE,
              ...(options.reason === undefined
                ? {}
                : { reason: options.reason }),
            },
          }),
    },
  };
}

/** Serve a minimal session-sourced detail for the shared panel. */
function mockDetail(callId: string, verdict: string): void {
  server.use(
    http.get('*/api/arbiter/log', ({ request }) => {
      const asked = new URL(request.url).searchParams.get('callId');
      if (asked !== callId)
        return HttpResponse.json(
          { ok: false, code: 'record-unavailable' },
          { status: 404 },
        );
      return HttpResponse.json({
        ok: true,
        detail: {
          callId,
          source: 'session',
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
            verdict,
            verdictReason: 'the verdict recorded with this call',
            configRevision: 'rev-1',
            fingerprint: 'fp-1',
            execution: {
              status: 'not-run',
              startedAt: null,
              finishedAt: null,
            },
            cancelled: false,
          },
          basis: {
            rule: null,
            decisionRules: [],
            conflicts: [],
            conflictsTruncated: false,
            policyStrategy: null,
            chain: null,
            reviewState: 'unknown',
            trace: [],
            signals: null,
            evidence: [],
            materials: [],
            evidenceTruncated: false,
            snapshotMissing: [],
            historyStatus: null,
            effect: null,
          },
          raw: {
            arguments: null,
            argumentsSchema: null,
            snapshot: null,
            config: null,
            configFormatVersion: null,
            snapshotFormatVersion: null,
            modelAttempts: [],
            templates: [],
            sessionRecordState: null,
          },
          missing: ['arguments-missing', 'snapshot-missing'],
          missingUnknown: 1,
        },
      });
    }),
  );
}

/** Render the real row for one decoded denial. */
function renderDenial(options: {
  readonly callId?: string;
  readonly tool?: string;
  readonly reason: string | null;
  readonly locale?: 'zh' | 'en';
}) {
  const denial = denialOf({
    name: ARBITER_DENIED_ERROR_NAME,
    code: ARBITER_DENIED_CODE,
    ...(options.reason === null ? {} : { reason: options.reason }),
  });
  if (denial === null) throw new Error('fixture must decode as a denial');
  return renderClient(
    <DenialRow
      callId={options.callId ?? 'call-1'}
      tool={options.tool ?? 'bash'}
      denial={denial}
    />,
    options.locale === undefined ? {} : { locale: options.locale },
  );
}

/** Render one denial built directly from its recorded fields. */
function renderRawDenial(denial: ArbiterDenialView, locale?: 'zh' | 'en') {
  return renderClient(
    <DenialRow callId="call-1" tool="bash" denial={denial} />,
    locale === undefined ? {} : { locale },
  );
}

describe('the denial decoder', () => {
  test('classifies each recorded stage from the feedback tag', () => {
    const cases: readonly (readonly [string, string])[] = [
      [RULE_REASON, 'rule'],
      [REVIEW_REASON, 'review'],
      [FALLBACK_REASON, 'fallback'],
      [HUMAN_REASON, 'human'],
      [ABORT_REASON, 'abort'],
    ];
    for (const [reason, expected] of cases) {
      expect(
        denialOf({
          name: ARBITER_DENIED_ERROR_NAME,
          code: ARBITER_DENIED_CODE,
          reason,
        })?.source,
      ).toBe(expected);
    }
  });

  test('keeps a real denial whose stage is unreadable unattributed', () => {
    const denial = denialOf({
      name: ARBITER_DENIED_ERROR_NAME,
      code: ARBITER_DENIED_CODE,
      reason: 'blocked without a stage tag',
    });
    // It is not guessed into "the user rejected it", and the recorded text is kept.
    expect(denial?.source).toBe('unattributed');
    expect(denial?.reason).toBe('blocked without a stage tag');
  });

  test('does not treat a host execution failure as an Arbiter denial', () => {
    // The host's own sandbox refusal, and a plain tool body error, are two
    // different owners; neither carries Arbiter's identity.
    expect(
      denialOf({
        name: 'SandboxError',
        code: 'SANDBOX_DENIED',
        reason: 'write outside the workspace',
      }),
    ).toBeNull();
    expect(denialOf({ name: 'Error', code: 'EPERM' })).toBeNull();
    expect(
      denialOf({
        name: ARBITER_DENIED_ERROR_NAME,
        code: 'SOMETHING_ELSE',
        reason: RULE_REASON,
      }),
    ).toBeNull();
    expect(denialOf(null)).toBeNull();
  });

  test('bounds a long reason and says that it did', () => {
    const long = `Not executed [deny-rule]: ${'x'.repeat(400)}`;
    const denial = denialOf({
      name: ARBITER_DENIED_ERROR_NAME,
      code: ARBITER_DENIED_CODE,
      reason: long,
    });
    expect(denial?.truncated).toBe(true);
    expect(denial?.reason?.endsWith('…')).toBe(true);
    // The record is untouched: the panel can still show all of it.
    expect(denial?.fullReason).toBe(long);
    expect((denial?.reason ?? '').length).toBeLessThan(long.length);
  });

  test('folds line breaks into one line without rewriting words', () => {
    const denial = denialOf({
      name: ARBITER_DENIED_ERROR_NAME,
      code: ARBITER_DENIED_CODE,
      reason:
        'Not executed [human-deny]: the user rejected this call.\n\nDo not retry.',
    });
    expect(denial?.reason).toBe(
      'Not executed [human-deny]: the user rejected this call. Do not retry.',
    );
    expect(denial?.truncated).toBe(false);
  });
});

describe('the denial row', () => {
  test('shows the Arbiter source, the stage and the short reason', () => {
    renderDenial({ reason: RULE_REASON });
    const status = screen.getByRole('status');
    expect(status.getAttribute('data-arbiter-denial')).toBe('rule');
    const header = within(status);
    expect(header.getByText('规则拒绝')).toBeInTheDocument();
    expect(header.getByText('bash')).toBeInTheDocument();
    // The reason is the recorded text, shown as recorded.
    expect(
      screen.getByText(/a deny rule matched this call/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '查看详情' }),
    ).toBeInTheDocument();
  });

  test('names a review denial, not a human refusal', () => {
    renderDenial({ reason: REVIEW_REASON });
    expect(screen.getByText('审查拒绝')).toBeInTheDocument();
    expect(screen.queryByText('用户拒绝')).toBeNull();
  });

  test('distinguishes an unavailable channel from a person saying no', () => {
    renderDenial({ reason: FALLBACK_REASON });
    expect(screen.getByText('无人工审批通道')).toBeInTheDocument();
    expect(screen.queryByText(/用户拒绍|用户拒绝/u)).toBeNull();
    expect(document.body.textContent).not.toMatch(/用户拒绍|用户拒绝/u);
  });

  test('shows a real human refusal as one', () => {
    renderDenial({ reason: HUMAN_REASON });
    expect(screen.getByText('用户拒绝')).toBeInTheDocument();
  });

  test('does not present an abandoned question as a refusal', () => {
    renderDenial({ reason: ABORT_REASON });
    expect(screen.getByText('审批未决结束')).toBeInTheDocument();
    expect(screen.queryByText('用户拒绝')).toBeNull();
  });

  test('explains a recorded denial that carries no reason', () => {
    renderDenial({ reason: null });
    expect(screen.getByText('Arbiter 已拒绝')).toBeInTheDocument();
    // The minimum verdict is still explained; the row is never blank.
    expect(
      screen.getByText(/该拒绝未记录原因；可打开调用详情查看最小裁决记录。/u),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: '查看详情' }),
    ).toBeInTheDocument();
  });

  test('states that a shortened reason was shortened', () => {
    renderDenial({
      reason: `Not executed [deny-rule]: ${'y'.repeat(400)}`,
    });
    expect(
      screen.getByText('原因已截断，完整内容见调用详情'),
    ).toBeInTheDocument();
  });

  test('opens the shared call detail for this callId only', async () => {
    const asked: string[] = [];
    server.use(
      http.get('*/api/arbiter/log', ({ request }) => {
        const callId = new URL(request.url).searchParams.get('callId') ?? '';
        asked.push(callId);
        return HttpResponse.json(
          { ok: false, code: 'record-unavailable' },
          { status: 404 },
        );
      }),
    );
    const { user } = renderDenial({
      callId: 'call-9',
      reason: RULE_REASON,
    });
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    await waitFor(() => {
      // Exactly this row's callId is requested, never a list or a guess.
      expect(asked).toEqual(['call-9']);
    });
    // The entry mounts #17's shared panel, whose own absence sentence appears.
    expect(await screen.findByText(/没有找到这条调用/u)).toBeInTheDocument();
  });

  test('the entry renders the shared detail, not a second surface', async () => {
    mockDetail('call-shared', 'deny');
    const { user } = renderDenial({
      callId: 'call-shared',
      reason: RULE_REASON,
    });
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    // The shared component owns the title and the three layers, so the session
    // entry and the log list cannot drift apart.
    expect(
      await screen.findByText('调用详情 · call-shared'),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('region', { name: '最终裁决' }),
    ).toBeInTheDocument();
    // Re-clicking collapses the same panel again.
    await user.click(screen.getByRole('button', { name: '收起详情' }));
    expect(screen.queryByText('调用详情 · call-shared')).toBeNull();
  });

  test('raises no toast or dialog for a refusal', () => {
    renderDenial({ reason: RULE_REASON });
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
    // A single inline status, not an interrupting surface.
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });

  test('renders Chinese per key when the English file is absent', () => {
    const denial = denialOf({
      name: ARBITER_DENIED_ERROR_NAME,
      code: ARBITER_DENIED_CODE,
      reason: RULE_REASON,
    });
    if (denial === null) throw new Error('fixture must decode as a denial');
    renderRawDenial(denial, 'en');
    // No bare key, no blank, no "undefined".
    expect(document.body.textContent).not.toMatch(
      /denials\.[a-zA-Z.]|undefined|\[object Object\]/u,
    );
    expect(screen.getByText('Arbiter 已拒绝')).toBeInTheDocument();
  });
});

describe('the session Definition', () => {
  test('claims only a tool/result carrying Arbiter identity, keyed by callId', () => {
    expect(
      denialDefinition.match(
        arbiterResult({ callId: 'call-a', tool: 'bash', reason: RULE_REASON }),
      ),
    ).toEqual({ id: 'call-a', role: 'start' });
    // An allowed call that then failed in the sandbox is the host's to show.
    expect(
      denialDefinition.match({
        type: 'tool/result',
        seq: 8,
        time: 0,
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-b',
            source: { callId: 'call-b', name: 'bash' },
            isError: true,
          },
          error: { name: 'SandboxError', code: 'SANDBOX_DENIED' },
        },
      }),
    ).toBeNull();
    // An ordinary successful call is not a denial either.
    expect(
      denialDefinition.match({
        type: 'tool/result',
        seq: 9,
        time: 0,
        data: {
          message: {
            role: 'tool',
            toolCallId: 'call-c',
            source: { callId: 'call-c', name: 'bash' },
          },
        },
      }),
    ).toBeNull();
    // A different event type is never claimed.
    expect(
      denialDefinition.match({ type: 'tool/call', seq: 1, time: 0, data: {} }),
    ).toBeNull();
  });

  test('anchors the row at its own result, so parallel calls cannot cross', () => {
    const first = arbiterResult({
      callId: 'call-first',
      tool: 'bash',
      reason: RULE_REASON,
    });
    const second = arbiterResult({
      callId: 'call-second',
      tool: 'read',
      reason: REVIEW_REASON,
    });
    const nodeOf = (event: Record<string, unknown>, seq: number) => {
      const start = { event: { ...event, seq } };
      const state = denialDefinition.start({}, start);
      return denialDefinition.buildViewNode({
        key: `arbiter-denial:${state.callId}`,
        id: state.callId,
        state,
        start,
      });
    };
    const a = nodeOf(first, 12);
    const b = nodeOf(second, 15);
    expect(a?.id).toBe('call-first');
    expect(b?.id).toBe('call-second');
    // Each row sorts by its own result seq and keeps its own tool, so an
    // interleaved parallel call cannot inherit the other's marker.
    expect(a?.anchorSeq).toBe(12);
    expect(b?.anchorSeq).toBe(15);
    expect(a?.data.tool).toBe('bash');
    expect(b?.data.tool).toBe('read');
    expect(a?.kind).toBe(DENIAL_NODE_KIND);
  });

  test('renders the registered node through the plugin dictionary', () => {
    const i18n = createArbiterI18n(createTestLocale());
    const View = createDenialNodeView(i18n);
    const state = denialDefinition.start(
      {},
      {
        event: arbiterResult({
          callId: 'call-x',
          tool: 'bash',
          reason: RULE_REASON,
        }),
      },
    );
    renderClient(<View node={{ data: state }} />);
    expect(screen.getByText('Arbiter 已拒绝')).toBeInTheDocument();
    expect(screen.getByRole('status').getAttribute('data-call-id')).toBe(
      'call-x',
    );
  });
});

describe('the denial detail fallback', () => {
  test('a session-sourced minimal record still explains the verdict', async () => {
    mockDetail('call-min', 'review-deny');
    const { user } = renderDenial({
      callId: 'call-min',
      reason: REVIEW_REASON,
    });
    await user.click(screen.getByRole('button', { name: '查看详情' }));
    // The shared panel renders this call although the audit row is absent: the
    // session record supplies the minimal verdict, and the panel says so rather
    // than claiming a record it does not have.
    expect(await screen.findByText('调用详情 · call-min')).toBeInTheDocument();
    expect(
      await screen.findByRole('region', { name: '最终裁决' }),
    ).toBeInTheDocument();
    // The absent layers are reported, not silently rendered empty.
    expect(screen.getByText(/审计/)).toBeInTheDocument();
  });
});
