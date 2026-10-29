/**
 * The rule draft a recorded call becomes, through the real page.
 *
 * The journey pinned here is the one the issue asks for: open a call, ask for a
 * rule, choose what to pin, see what stays open, then test the draft with the
 * same call before saving. The verdicts in these tests come from the real
 * evaluator behind the tester route — the assertions are about what the shared
 * matcher answers for the draft the dialog built, not about a fixture.
 */

import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, test } from 'vitest';

import { commandRule } from '../../src/client/decoders/config.js';
import { ArbiterPage } from '../../src/client/index.js';
import type { CommandRule } from '../../src/types.js';
import { evaluateCall } from '../../src/rules/match.js';
import { setupApiMock } from '../helpers/api-mock.js';
import { effectiveState } from '../helpers/client-state.js';
import { renderClient } from '../helpers/render-client.js';

const server = setupApiMock();

const CALL_ID = 'call-deploy-1';
const DEPLOY_ARGS = { environments: ['test'], dryRun: true, retries: 2 };

/** The call detail the log list opens, shaped as the host route answers. */
function detailBody() {
  return {
    ok: true,
    detail: {
      callId: CALL_ID,
      source: 'audit',
      recordFormatVersion: 2,
      unreadable: false,
      unreadableReason: null,
      overview: {
        tool: 'deploy',
        ts: 1_700_000_000_000,
        sessionId: 'session-1',
        sessionKind: 'main',
        parentSession: null,
        workspace: '/srv/app',
        cwd: '/srv/app',
        profile: 'default',
        approvalMode: 'normal',
        executionMode: 'guarded',
        verdict: 'review-allow',
        verdictReason: 'the review allowed this call',
        configRevision: 'rev-1',
        fingerprint: 'deploy:1',
        execution: { status: 'succeeded', startedAt: 1, finishedAt: 2 },
        cancelled: false,
      },
      basis: {
        rule: null,
        decisionRules: [],
        conflicts: [],
        conflictsTruncated: false,
        policyStrategy: 'normal',
        chain: [],
        reviewState: 'reviewed',
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
        arguments: DEPLOY_ARGS,
        argumentsSchema: null,
        snapshot: null,
        config: null,
        configFormatVersion: null,
        snapshotFormatVersion: null,
        modelAttempts: [],
        templates: [],
        sessionRecordState: 'written',
      },
      missing: [],
      missingUnknown: 0,
    },
  };
}

/** One log row, so the list has the call the detail is opened for. */
function logRows() {
  return {
    ok: true,
    rows: [
      {
        callId: CALL_ID,
        ts: 1_700_000_000_000,
        sessionId: 'session-1',
        sessionKind: 'main',
        tool: 'deploy',
        command: 'deploy --dry-run',
        result: 'review-allow',
        ruleId: null,
        unreadable: false,
      },
    ],
    total: 1,
    limit: 25,
    nextCursor: null,
    prevCursor: null,
    anchor: { ts: 1_700_000_000_000, callId: CALL_ID },
    newer: 0,
    remaining: 0,
  };
}

/**
 * The tester route, answered by the real evaluator.
 *
 * This is what makes the "test the draft" assertions meaningful: the page's
 * request body is evaluated by `evaluateCall`, the same function the host route
 * uses, so the rendered conclusion follows from the draft the dialog produced.
 */
function evaluateSubmitted() {
  return http.post('*/api/arbiter/test', async ({ request }) => {
    const body: unknown = await request.json();
    const parsed = testerRequest(body);
    const evaluation = evaluateCall({
      rules: parsed.rules,
      tool: parsed.tool,
      arguments: parsed.args,
      identity: 'main',
      workspaceRoot: '/srv/app',
      cwd: '/srv/app',
      parentAuthorizationPresent: null,
      historyTruncated: false,
      overlapsDeniedEffect: false,
    });
    return HttpResponse.json({
      ok: true,
      results: [
        {
          input: JSON.stringify(parsed.args),
          tool: parsed.tool,
          cwd: '/srv/app',
          path:
            evaluation.path.kind === 'rule'
              ? evaluation.path.verdict
              : 'review(default)',
          pathDetail: evaluation.path,
          rule: evaluation.matches.find((match) => match.effective) ?? null,
          matches: evaluation.matches,
          rules: evaluation.rules,
          parse: {
            status: evaluation.parse.status,
            statements: evaluation.parse.statements,
            nodes: [],
            completeness: evaluation.parse.completeness,
            opaque: evaluation.parse.opaque,
            unresolved: evaluation.parse.unresolved,
          },
          argv: [],
          normalization: evaluation.normalization,
          shadowed: evaluation.shadowed,
        },
      ],
    });
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The parts of the submitted tester body the real evaluator needs.
 *
 * The rules go through the page's own decoder, so the evaluator sees the same
 * shape it would receive from the host route.
 */
function testerRequest(body: unknown): {
  readonly rules: readonly CommandRule[];
  readonly tool: string;
  readonly args: unknown;
} {
  const record = isRecord(body) ? body : {};
  const samples = Array.isArray(record['samples']) ? record['samples'] : [];
  const first = isRecord(samples[0]) ? samples[0] : {};
  const rules = Array.isArray(record['rules']) ? record['rules'] : [];
  return {
    rules: rules.map((entry) => commandRule(entry)),
    tool: typeof first['tool'] === 'string' ? first['tool'] : '',
    args: first['args'],
  };
}

/** Every save body the page submitted, for the "cancel changes nothing" case. */
const saves: unknown[] = [];

/**
 * The rules one submitted save body carried, decoded by the page's own decoder.
 *
 * Reading through the decoder keeps the assertion about what the host would
 * actually parse rather than about a hand-cast shape.
 */
function savedRules(body: unknown): readonly CommandRule[] {
  const record = isRecord(body) ? body : {};
  const config = isRecord(record['config']) ? record['config'] : {};
  const rules = Array.isArray(config['rules']) ? config['rules'] : [];
  return rules.map((entry) => commandRule(entry));
}

function baseHandlers(): void {
  saves.length = 0;
  server.use(
    http.get('*/api/arbiter/state', () => HttpResponse.json(effectiveState())),
    http.get('*/api/arbiter/logs', () => HttpResponse.json(logRows())),
    http.get('*/api/arbiter/log', () => HttpResponse.json(detailBody())),
    http.post('*/api/arbiter/validate', () =>
      HttpResponse.json({ ok: true, errors: [], warnings: [] }),
    ),
    http.post('*/api/arbiter/config/save', async ({ request }) => {
      saves.push(await request.json());
      return HttpResponse.json({
        ok: true,
        saved: true,
        changed: true,
        effective: true,
        effectiveRevision: 'effective-2',
        configSnapshotId: 'snapshot-2',
        activationRecorded: true,
        configFormat: 'arbiter-config-v3',
        configFormatExplicit: true,
        auditError: null,
        warnings: [],
      });
    }),
    evaluateSubmitted(),
  );
}

/** Open the log list and the shared call detail for the seeded call. */
async function openCall(user: ReturnType<typeof renderClient>['user']) {
  await user.click(await screen.findByRole('button', { name: '日志与详情' }));
  await user.click(
    await screen.findByRole('button', { name: new RegExp('deploy', 'u') }),
  );
  await screen.findByRole('heading', { name: `调用详情 · ${CALL_ID}` });
}

/**
 * Ask the open detail for a rule.
 *
 * The request closes the call detail and switches to the rules tab, so the draft
 * dialog opens on a page the user can see rather than under a modal.
 */
async function openDraftDialog(
  user: ReturnType<typeof renderClient>['user'],
): Promise<HTMLElement> {
  await user.click(
    screen.getByRole('button', { name: '从这次调用创建规则', exact: true }),
  );
  return await screen.findByRole('dialog', {
    name: '从这次调用创建规则草稿',
  });
}

describe('creating a rule draft from a recorded call', () => {
  test('pins the values the user selected and shows the ones it leaves open', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);

    // Every pinnable value starts checked: reproducing the call exactly is the
    // safe default, and narrowing it is an explicit act.
    expect(within(dialog).getAllByRole('checkbox').every(isChecked)).toBe(true);
    // The label is the condition's own address — `tool` or its JSONPath — so it
    // stays the protocol value rather than a translated field name.
    expect(within(dialog).getByText(/^tool = /u)).toBeVisible();
    expect(within(dialog).getByText('$.dryRun = true')).toBeVisible();

    // The array cannot be pinned by an exact match, so it is named as open
    // rather than silently dropped.
    const unfixed = within(dialog).getByRole('region', {
      name: '这次调用中规则未限定的部分',
    });
    expect(unfixed).toHaveTextContent('$.environments 是数组');

    // Unchecking the tool leaves the argument conditions, and the dialog then
    // says the rule no longer constrains the tool.
    const toolCheckbox = within(dialog).getAllByRole('checkbox')[0];
    if (toolCheckbox === undefined) throw new Error('no tool checkbox');
    await user.click(toolCheckbox);
    await waitFor(() => {
      expect(unfixed).toHaveTextContent('未勾选：tool');
    });
    expect(
      within(dialog).getByRole('button', { name: '生成草稿', exact: true }),
    ).toBeEnabled();
  });

  test('the created draft matches the call that produced it', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);
    await user.click(
      within(dialog).getByRole('button', {
        name: '生成草稿并测试',
        exact: true,
      }),
    );

    // The tester opens on the new rule with the recorded call as its sample; the
    // draft is named in the tester's own target line, so the rule the test is
    // about is the one the dialog just built.
    const dialogAfter = await screen.findByRole('dialog', { name: '规则测试' });
    expect(
      within(dialogAfter).getByText(
        `本次测试使用调用记录 ${CALL_ID} 的原始输入。`,
      ),
    ).toBeVisible();
    expect(within(dialogAfter).getByLabelText('工具')).toHaveValue('deploy');
    expect(within(dialogAfter).getByText(/^当前规则：/u)).toBeVisible();
    expect(within(dialogAfter).getByLabelText('工具参数')).toHaveValue(
      JSON.stringify(DEPLOY_ARGS, null, 2),
    );

    // Running the test answers with the real evaluator: the rule the dialog
    // built matches this call.
    await user.click(
      within(dialogAfter).getByRole('button', { name: '运行测试' }),
    );
    const conclusion = await screen.findByTestId('rule-test-rule');
    expect(conclusion).toHaveAttribute('data-arbiter-test-rule-state', 'match');
  });

  test('the draft is only a draft: it takes effect through save and apply', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);
    await user.click(
      within(dialog).getByRole('button', { name: '生成草稿', exact: true }),
    );

    // Nothing was written to the configuration by creating the draft.
    expect(saves).toEqual([]);
    await user.click(
      await screen.findByRole('button', { name: '保存并应用', exact: true }),
    );
    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    const rules = savedRules(saves[0]);
    expect(rules).toHaveLength(1);
    expect(rules[0]?.conditions).toHaveLength(3);
  });

  test('cancelling the dialog changes no rule', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);
    await user.click(
      within(dialog).getByRole('button', { name: '取消', exact: true }),
    );
    expect(
      screen.queryByRole('dialog', { name: '从这次调用创建规则草稿' }),
    ).toBeNull();
    // Back on the rules tab with the draft untouched.
    expect(screen.getByText(/^还没有规则/u)).toBeVisible();
    expect(saves).toEqual([]);
  });

  test("the behavior is the user's choice, not the call's recorded outcome", async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);

    // The call was allowed by review; the draft still starts as force-review,
    // which is the safe direction and is never inherited from the outcome.
    const behavior = within(dialog).getByLabelText('生成规则的行为');
    expect(behavior).toHaveValue('force-review');
    // The behavior note spells out what the selected verdict does, in engine
    // terms, so the choice is not made from a short option label alone.
    expect(dialog).toHaveTextContent(
      '始终模型审查（必交 reviewer；hint 只提供关注点）',
    );

    await user.selectOptions(behavior, 'deny');
    await user.click(
      within(dialog).getByRole('button', { name: '生成草稿', exact: true }),
    );
    await user.click(
      await screen.findByRole('button', { name: '保存并应用', exact: true }),
    );
    await waitFor(() => {
      expect(saves).toHaveLength(1);
    });
    expect(savedRules(saves[0])[0]?.verdict).toBe('deny');
  });

  test('the rules tab is the other entry into the same draft dialog', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await user.click(await screen.findByRole('button', { name: '规则' }));
    await user.click(
      await screen.findByRole('button', { name: '从调用记录创建规则' }),
    );
    // The popover lists the same recorded calls the tester's own import reads.
    await user.click(
      await screen.findByRole('button', {
        name: new RegExp(`带入 deploy 调用 ${CALL_ID}`, 'u'),
      }),
    );
    const dialog = await screen.findByRole('dialog', {
      name: '从这次调用创建规则草稿',
    });
    expect(dialog).toHaveTextContent(`来源调用：${CALL_ID}`);
    expect(within(dialog).getByText(/^tool = /u)).toBeVisible();

    await user.click(
      within(dialog).getByRole('button', { name: '生成草稿', exact: true }),
    );
    const row = await screen.findByRole('list', { name: '规则' });
    expect(within(row).getAllByRole('listitem')).toHaveLength(1);
    // No test was requested, so nothing claims to have tested the new rule.
    expect(screen.queryByRole('dialog', { name: '规则测试' })).toBeNull();
  });

  test('re-testing a rule built from a call starts from that call again', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);
    await user.click(
      within(dialog).getByRole('button', {
        name: '生成草稿并测试',
        exact: true,
      }),
    );
    const tester = await screen.findByRole('dialog', { name: '规则测试' });
    // Edit the sample, close the tester, then ask for that rule again: the
    // recorded call is the rule's own source, so it is restored rather than the
    // edited sample being silently reused.
    const args = within(tester).getByLabelText('工具参数');
    await user.clear(args);
    await user.type(args, '{{"dryRun":false}');
    await user.click(within(tester).getByRole('button', { name: '关闭' }));

    await user.click(await screen.findByRole('button', { name: /^测试规则/u }));
    const again = await screen.findByRole('dialog', { name: '规则测试' });
    expect(within(again).getByLabelText('工具参数')).toHaveValue(
      JSON.stringify(DEPLOY_ARGS, null, 2),
    );
    expect(
      within(again).getByText(`本次测试使用调用记录 ${CALL_ID} 的原始输入。`),
    ).toBeVisible();
  });

  test('an edited sample no longer claims to be the recorded call', async () => {
    baseHandlers();
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    const dialog = await openDraftDialog(user);
    await user.click(
      within(dialog).getByRole('button', {
        name: '生成草稿并测试',
        exact: true,
      }),
    );
    const tester = await screen.findByRole('dialog', { name: '规则测试' });
    const args = within(tester).getByLabelText('工具参数');
    await user.type(args, ' ');
    expect(
      within(tester).getByText(
        `输入已改动，下面测试的不再是调用记录 ${CALL_ID} 的原样输入。`,
      ),
    ).toBeVisible();
  });

  test('a call without stored input offers no draft and says so', async () => {
    baseHandlers();
    server.use(
      http.get('*/api/arbiter/log', () => {
        const body = detailBody();
        return HttpResponse.json({
          ok: true,
          detail: {
            ...body.detail,
            raw: { ...body.detail.raw, arguments: null },
          },
        });
      }),
    );
    const { user } = renderClient(<ArbiterPage />);
    await openCall(user);
    expect(
      screen.getByText(
        '这条记录没有保存这次调用的输入，因此无法从它生成规则草稿。',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: '从这次调用创建规则', exact: true }),
    ).toBeNull();
  });
});

/** Whether a checkbox role element is checked, without casting it. */
function isChecked(element: HTMLElement): boolean {
  return (
    element.getAttribute('aria-checked') === 'true' ||
    element.hasAttribute('checked')
  );
}
