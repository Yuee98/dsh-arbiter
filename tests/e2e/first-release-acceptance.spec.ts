/**
 * The first-release product journey in one real host (#23).
 *
 * The leaf issues each prove their own slice in this suite. What none of them
 * proves is the join, which is the only thing this case asserts: one real
 * session, on one pinned head, that is configured through the real UI, enabled
 * through the real permission seat, refused by a rule, reviewed by the
 * deterministic Reviewer, explained through the shared detail, and then still
 * decided the same way after the host process restarts.
 *
 * Deliberate boundaries:
 *   - The model is the fixture adapter, so the review path is deterministic and
 *     needs no credential. Real model quality is a separate record (#22);
 *     this case only claims the wiring.
 *   - Nothing here re-implements an individual leaf contract. Where a fact is
 *     already owned elsewhere (the selector's menu semantics in
 *     permission-selector.spec.ts, the marker's placement in
 *     session-denial.spec.ts), this case links the steps and asserts the join.
 *   - It is not an `@smoke` case: a cross-process restart belongs in the full
 *     suite, not in the daily smoke budget.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import {
  effectivePermission,
  lastAdmission,
  waitForSession,
  type LoggedSession,
} from './dsh/session-log.js';

const FORMAT = 'arbiter-config-v2';

/** The deny rule the journey installs through the real editor. */
const DENY_RULE = {
  id: 'journey-deny',
  name: '拒绝旅程探针命令',
  scope: { tools: ['bash'] },
  conditions: [
    // `touch` is one command node whose own text creates the file, so the
    // denied command's only effect is observable on disk. A regression that
    // executed the body and then reported a denial cannot pass. The path is
    // absolute because a session's working directory is not the workspace root.
    {
      target: 'argument',
      path: '$.command',
      kind: 'regex',
      pattern: 'touch .*journey-denied-(?:probe|restart)\\.txt',
    },
  ],
  verdict: 'deny',
};

interface StepRecord {
  readonly at: number;
  readonly step: string;
  readonly detail?: unknown;
}

/** One ordered record of the journey, attached on exit. */
class Steps {
  private readonly entries: StepRecord[] = [];
  private readonly started = Date.now();

  add(step: string, detail?: unknown): void {
    this.entries.push({
      at: Date.now() - this.started,
      step,
      ...(detail === undefined ? {} : { detail }),
    });
  }

  json(): string {
    return JSON.stringify(this.entries, null, 2);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

/** The plugin's own state document, as the page reads it. */
interface ArbiterState {
  readonly revision: string | null;
  readonly config: Record<string, unknown>;
  readonly rules: readonly Record<string, unknown>[];
  readonly modes: Record<string, unknown>;
  readonly effectiveRevision: string;
  readonly configSnapshotId: string;
  readonly configFormat: string;
  readonly invalidConfigError: unknown;
}

async function readState(host: DshHost): Promise<ArbiterState> {
  const response = await fetch(`${host.origin}/api/arbiter/state`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  expect(response.status).toBe(200);
  const body = record(await response.json(), 'state');
  const config = record(body['config'], 'config');
  const rules = config['rules'];
  if (!Array.isArray(rules)) throw new TypeError('config.rules must be a list');
  const revision = body['fileRevision'];
  return {
    revision: typeof revision === 'string' ? revision : null,
    config,
    rules: rules.map((entry) => record(entry, 'rules[]')),
    modes: record(config['modes'], 'modes'),
    effectiveRevision: String(body['effectiveRevision']),
    configSnapshotId: String(body['configSnapshotId']),
    configFormat: String(body['configFormat']),
    invalidConfigError: body['invalidConfigError'],
  };
}

/** One session's admission view, over the public route. */
async function admissionView(
  host: DshHost,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${host.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { cookie: `${host.cookie.name}=${host.cookie.value}` } },
  );
  const body = record(await response.json(), 'admission');
  return record(body['admission'], 'admission.admission');
}

/** Poll the admission view until it satisfies `matches`, or return null. */
async function waitForAdmission(
  host: DshHost,
  sessionId: string,
  matches: (admission: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await admissionView(host, sessionId).catch(() => ({}));
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** Open the isolated host with its own bootstrap cookie. */
async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  for (const pattern of [/预览版说明|Preview/i, /开始使用|Get started/i]) {
    const dialog = page.getByRole('dialog', { name: pattern });
    if (await dialog.isVisible().catch(() => false)) {
      await dialog
        .getByRole('button', { name: /^(继续|Continue|关闭|Close)$/ })
        .first()
        .click();
    }
  }
}

/**
 * Reopen an existing session from the host's sidebar by its own title.
 *
 * Navigating through the session list is the product's path back to a
 * conversation; it also proves the page can leave the plugin configuration
 * without losing the admission it just applied.
 */
async function openExistingSession(
  page: Page,
  titleFragment: string,
): Promise<void> {
  const row = page.getByRole('treeitem', { name: new RegExp(titleFragment) });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
}

/** Send one line into the real composer. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/**
 * The permission seat the host renders in the composer.
 *
 * This is the host's own slot, found by its public `data-slot`, not by any
 * class name, and the occupant is the plugin's registered control.
 */
function permissionSeat(page: Page) {
  return page.locator('[data-slot="conversation.input.permission"]');
}

function arbiterControl(page: Page) {
  return permissionSeat(page).locator('[data-arbiter-permission]');
}

/** Wait for the session carrying `marker` whose turn has settled. */
async function settledSession(
  host: DshHost,
  marker: string,
  timeoutMs = 120_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some((event) =>
        JSON.stringify(event.data).includes(marker),
      ) && candidate.events.some((event) => event.type === 'turn/end'),
    timeoutMs,
  );
  if (session === null) throw new Error(`session ${marker} never settled`);
  return session;
}

/** The text one recorded `tool/result` carried, as the log stored it. */
function resultText(result: Readonly<Record<string, unknown>>): string {
  const message = result['message'];
  if (!isRecord(message)) return '';
  const content = message['content'];
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: unknown) => {
      if (!isRecord(block)) return [];
      return typeof block['text'] === 'string' ? [block['text']] : [];
    })
    .join('\n');
}

/** The `callId` a recorded result names. */
function recordedCallId(
  result: Readonly<Record<string, unknown>>,
): string | null {
  const message = result['message'];
  if (!isRecord(message)) return null;
  const source = message['source'];
  if (!isRecord(source)) return null;
  const callId = source['callId'];
  return typeof callId === 'string' ? callId : null;
}

/** The Arbiter denial identity one result recorded, if any. */
function denialOf(
  result: Readonly<Record<string, unknown>>,
): { readonly callId: string; readonly reason: string | null } | null {
  const error = result['error'];
  if (!isRecord(error)) return null;
  if (error['name'] !== 'ArbiterDeniedError') return null;
  if (error['code'] !== 'ARBITER_DENIED') return null;
  const callId = recordedCallId(result);
  if (callId === null) return null;
  return {
    callId,
    reason: typeof error['reason'] === 'string' ? error['reason'] : null,
  };
}

/** The durable `tool/result` payloads of one session. */
function toolResults(
  session: LoggedSession,
): readonly Readonly<Record<string, unknown>>[] {
  return session.events
    .filter((event) => event.type === 'tool/result')
    .flatMap((event) => (isRecord(event.data) ? [{ ...event.data }] : []));
}

/** The sealed verdicts the plugin appended for one call id. */
function decisionsFor(
  session: LoggedSession,
  callId: string,
): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .flatMap((event) => (isRecord(event.data) ? [{ ...event.data }] : []))
    .filter((data) => JSON.stringify(data).includes(`"callId":"${callId}"`));
}

/**
 * Reveal the disclosures that hide one call's row.
 *
 * A Chat row beside a call is folded twice on a settled Turn, and both folds
 * belong to the host: the Turn-level "worked/finished" header and the
 * step-process group header. This journey has several settled Turns, so the
 * helper expands the ones that carry the row's own `data-chat-turn` and then
 * requires the row to be genuinely visible. Nothing here writes host state.
 */
async function revealTurnProcess(page: Page, callId: string): Promise<void> {
  const row = page.locator(`[data-arbiter-row="${callId}"]`);
  await expect(row).toHaveCount(1);
  for (let attempt = 0; attempt < 12; attempt += 1) {
    if (await row.isVisible().catch(() => false)) return;
    const acted = await page.evaluate((id: string) => {
      const rowElement = document.querySelector(`[data-arbiter-row="${id}"]`);
      if (rowElement === null) return 0;
      const turn = rowElement
        .closest('[data-chat-turn]')
        ?.getAttribute('data-chat-turn');
      let clicks = 0;
      const click = (element: Element | null | undefined): void => {
        if (!(element instanceof HTMLElement)) return;
        element.click();
        clicks += 1;
      };
      // The step-process group header that owns this row.
      const group = rowElement.closest('[data-step-process]');
      if (group !== null) {
        const header = group.querySelector(':scope > div:first-child button');
        if (header?.getAttribute('aria-expanded') === 'false') click(header);
      }
      // The Turn-level header. It is a sibling of the process group, so it is
      // found by its own Turn scope and by not living inside a step group.
      for (const toggle of document.querySelectorAll(
        '[data-slot="conversation.view"] button[aria-expanded]',
      )) {
        if (toggle.getAttribute('aria-expanded') !== 'false') continue;
        if (toggle.closest('[data-step-process]') !== null) continue;
        if (
          turn !== null &&
          toggle.closest('[data-chat-turn]')?.getAttribute('data-chat-turn') !==
            turn
        ) {
          continue;
        }
        click(toggle);
      }
      return clicks;
    }, callId);
    await page.waitForTimeout(acted === 0 ? 250 : 120);
  }
  await expect(row).toBeVisible();
}

test('one session is configured, enabled, denied, reviewed and recovered', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('first-release-acceptance'),
    { arbiterRowConfig: { format: FORMAT, rules: [] } },
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);

    // ---- 1. Configure: an empty rule set, then a real rule through the UI ---
    // The first-release default is an empty rule table and no takeover. The
    // plugin page is the real configuration surface, so the rule is created
    // there rather than by rewriting the profile patch behind the UI.
    const before = await readState(host);
    expect(before.rules).toEqual([]);
    expect(before.configFormat).toBe(FORMAT);
    expect(before.invalidConfigError).toBeNull();
    steps.add('configured-empty', {
      effectiveRevision: before.effectiveRevision,
      configFormat: before.configFormat,
    });

    // A real agent turn before any rule exists: nothing is gated yet, because
    // installing the plugin must not take over a session.
    await sendPrompt(page, 'JOURNEY-WARM RUN echo journey-warmup');
    const warm = await settledSession(host, 'JOURNEY-WARM');
    const sessionId = warm.sessionId;
    expect(await admissionView(host, sessionId)).toMatchObject({
      enabled: false,
      managed: false,
    });
    expect(
      warm.events.some((event) => event.type === 'plugin:arbiter/decision'),
    ).toBe(false);
    steps.add('not-taken-over', { sessionId });

    // ---- 2. Enable through the real permission seat ------------------------
    const seat = permissionSeat(page);
    await expect(seat).toBeVisible();
    await expect(arbiterControl(page)).toHaveCount(1);
    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    const admission = await waitForAdmission(
      host,
      sessionId,
      (view) => view['enabled'] === true,
    );
    expect(admission).not.toBeNull();
    expect(admission).toMatchObject({ enabled: true, managed: true });
    // Durable, not only the control's rendering.
    const admitted = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some(
          (event) => event.type === 'plugin:arbiter/admission',
        ),
    );
    expect(lastAdmission(admitted?.events ?? [])).toMatchObject({
      enabled: true,
    });
    steps.add('enabled', admission);

    // ---- 3. A rule refusal on a real tool call ----------------------------
    // Install the deny rule through the plugin page's own editor and save bar.
    const plugin = page.locator('[data-arbiter-root]');
    await page.getByRole('button', { name: /^(插件|Plugins)$/u }).click();
    const pluginDetail = page.getByRole('button', {
      name: /^(查看|View) dsh-arbiter$/u,
    });
    await pluginDetail.click();
    await plugin.getByRole('button', { name: '规则', exact: true }).click();
    await plugin.getByRole('button', { name: '新建规则', exact: true }).click();
    const row = plugin.locator('[data-rule-row]');
    await expect(row).toHaveCount(1);
    const ruleId = await row.getAttribute('data-rule-row');
    expect(ruleId).toBeTruthy();
    await row.getByRole('combobox', { name: /^行为/ }).selectOption('deny');
    await row
      .getByRole('textbox', { name: '工具', exact: true })
      .pressSequentially('bash');
    await row
      .getByRole('textbox', { name: '表达式', exact: true })
      .pressSequentially(DENY_RULE.conditions[0]?.pattern ?? '');
    const [saved] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/config/save',
      ),
      plugin.getByRole('button', { name: '保存并应用', exact: true }).click(),
    ]);
    expect(saved.status()).toBe(200);
    await expect(
      plugin.locator('[data-arbiter-save-status="saved"]'),
    ).toHaveText('已保存并生效。');

    // The saved configuration is effective, not merely written: the revision
    // moved and the rule lives in the running configuration.
    const afterSave = await readState(host);
    expect(afterSave.effectiveRevision).not.toBe(before.effectiveRevision);
    expect(afterSave.invalidConfigError).toBeNull();
    expect(afterSave.rules).toHaveLength(1);
    expect(afterSave.rules[0]).toMatchObject({ id: ruleId, verdict: 'deny' });
    steps.add('rule-saved', {
      ruleId,
      effectiveRevision: afterSave.effectiveRevision,
      snapshotId: afterSave.configSnapshotId,
    });

    // Back to the conversation through the host's own session list, then send
    // the refused call. The composer is the host's own, so the turn is a real
    // one issued by the session that was just configured and enabled.
    await openExistingSession(page, 'JOURNEY-WARM');
    // The command's only effect is creating a file inside the isolated
    // workspace, so the denial is proven by the file's absence rather than by
    // the absence of output (an implementation could execute first and then
    // replace the result with a denial, which "no output" would not catch).
    const deniedTarget = join(host.workspace, 'journey-denied-probe.txt');
    await sendPrompt(page, `JOURNEY-DENY RUN touch ${deniedTarget}`);
    const denied = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        toolResults(candidate).some((result) => denialOf(result) !== null) &&
        candidate.events.some((event) => event.type === 'turn/end'),
      120_000,
    );
    expect(denied).not.toBeNull();
    const deniedSession = denied ?? warm;
    const denials = toolResults(deniedSession)
      .map(denialOf)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    expect(denials).toHaveLength(1);
    const denial = denials[0];
    if (denial === undefined) throw new Error('no denial recorded');
    // A rule refusal names the rule stage, and the body never ran: the command
    // output is absent from the recorded result.
    expect(denial.reason).toContain('deny-rule');
    const deniedResult = toolResults(deniedSession).find(
      (result) => recordedCallId(result) === denial.callId,
    );
    expect(deniedResult).toBeDefined();
    // The refused command created no file: this is an execution effect, not a
    // text check on the plugin's own verdict.
    await expect(readFile(deniedTarget, 'utf8')).rejects.toThrow();
    // The decision record for that exact call id says the rule decided it, so
    // the refusal is attributed rather than guessed.
    const ruleDecision = decisionsFor(deniedSession, denial.callId);
    expect(ruleDecision).toHaveLength(1);
    expect(ruleDecision[0]).toMatchObject({ result: 'deny' });
    steps.add('denied', {
      callId: denial.callId,
      reason: denial.reason,
      decision: ruleDecision[0],
    });

    // A positive control for the same effect: a command of the same shape that
    // no rule covers does create its file, so "no file" is evidence about this
    // refused command rather than about a workspace that could not be written.
    const allowedTarget = join(host.workspace, 'journey-allowed-probe.txt');
    await sendPrompt(page, `JOURNEY-CONTROL RUN touch ${allowedTarget}`);
    const control = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.filter((event) => event.type === 'turn/end').length >=
          3,
      120_000,
    );
    expect(control).not.toBeNull();
    expect(await readFile(allowedTarget, 'utf8')).toBe('');

    // ---- 4. The model review path on the next real call --------------------
    // The fixture Reviewer answers a fixed low-risk, authorized verdict, so a
    // call that no rule covers reaches model review and settles as
    // `review-allow`. That is the join this journey needs: the same session,
    // the same configuration, the other branch of the gate.
    await sendPrompt(page, 'JOURNEY-REVIEW RUN echo journey-review-allowed');
    const reviewed = await waitForSession(
      host.home,
      (candidate) => {
        if (candidate.sessionId !== sessionId) return false;
        // The call is identified by its own output as well as its verdict: the
        // earlier positive control also settled as `review-allow`, so waiting on
        // the verdict alone would return before this turn had been read.
        return toolResults(candidate).some((result) => {
          if (!resultText(result).includes('journey-review-allowed'))
            return false;
          const callId = recordedCallId(result);
          if (callId === null) return false;
          return decisionsFor(candidate, callId).some(
            (entry) => entry['result'] === 'review-allow',
          );
        });
      },
      120_000,
    );
    if (reviewed === null) {
      const dump = (
        await waitForSession(host.home, (c) => c.sessionId === sessionId, 5_000)
      )?.events
        .filter((e) => e.type === 'tool/result' || e.type === 'tool/call')
        .map((e) => `${e.type}: ${JSON.stringify(e.data).slice(0, 300)}`);
      throw new Error(
        `no review-allow for the review probe: ${JSON.stringify(dump, null, 2)}`,
      );
    }
    const reviewedSession = reviewed;
    // Select the review-path call by both its own output and its verdict: the
    // positive-control call above also settles as `review-allow` and produces no
    // output, so matching on the verdict alone would pick the wrong result.
    const reviewedCall = toolResults(reviewedSession)
      .filter(
        (result) =>
          resultText(result).includes('journey-review-allowed') &&
          (() => {
            const callId = recordedCallId(result);
            if (callId === null) return false;
            return decisionsFor(reviewedSession, callId).some(
              (entry) => entry['result'] === 'review-allow',
            );
          })(),
      )
      .at(-1);
    expect(reviewedCall).toBeDefined();
    const reviewedCallId = recordedCallId(reviewedCall ?? {});
    expect(reviewedCallId).not.toBeNull();
    // The allowed call really executed: its own output is in the result, which
    // separates "review allowed" from "nothing happened".
    expect(resultText(reviewedCall ?? {})).toContain('journey-review-allowed');
    steps.add('review-allowed', { callId: reviewedCallId });

    // ---- 5. Session feedback and the shared detail ------------------------
    await revealTurnProcess(page, denial.callId);
    const marker = page.locator('[data-arbiter-denial]');
    await expect(marker).toHaveCount(1);
    await expect(marker).toHaveAttribute('data-call-id', denial.callId);
    await expect(marker).toContainText('Arbiter 已拒绝');
    await expect(marker).toContainText('规则拒绝');

    // Opening it reaches the shared detail for the same call id, and the detail
    // explains the verdict rather than presenting an empty panel.
    await page.locator('[data-arbiter-row] button').first().click({
      timeout: 10_000,
    });
    await expect(page.getByText(`调用详情 · ${denial.callId}`)).toBeVisible();
    await expect(page.getByRole('region', { name: '最终裁决' })).toBeVisible();
    steps.add('detail-opened', { callId: denial.callId });

    // ---- 6. Recovery: the same profile after a real process restart -------
    const restarted = await caseHost.restart();
    // What survives is the configuration content, not the activation identity:
    // a restart legitimately appends a new `startup` activation with its own
    // revision, while the content snapshot (deduplicated by content) and the
    // applied rule must be the same ones this journey saved.
    const recovered = await readState(restarted);
    expect(recovered.configSnapshotId).toBe(afterSave.configSnapshotId);
    expect(recovered.configFormat).toBe(afterSave.configFormat);
    expect(recovered.rules).toHaveLength(1);
    expect(recovered.rules[0]).toMatchObject({ id: ruleId, verdict: 'deny' });
    expect(recovered.invalidConfigError).toBeNull();

    // The session must be reopened before it is live in the new process, which
    // is exactly a cold restore, not a warm cache.
    await openHost(page, restarted);
    await openExistingSession(page, 'JOURNEY-WARM');
    await expect(
      page.locator('[data-slot="conversation.input.permission"]'),
    ).toBeVisible();
    const restored = await waitForAdmission(
      restarted,
      sessionId,
      (view) => view['enabled'] === true,
    );
    expect(restored).not.toBeNull();
    expect(restored).toMatchObject({ enabled: true, managed: true });
    steps.add('recovered', {
      sessionId,
      admission: restored,
      configSnapshotId: recovered.configSnapshotId,
      effectiveRevisionBefore: afterSave.effectiveRevision,
      effectiveRevisionAfter: recovered.effectiveRevision,
    });

    // And the restored admission still decides: the same rule refuses again.
    // The same observable effect as the first refusal: a new marker file that
    // must not exist afterwards, so a post-restart denial that silently
    // executed would fail here.
    const restartTarget = join(host.workspace, 'journey-denied-restart.txt');
    await sendPrompt(page, `JOURNEY-AFTER-RESTART RUN touch ${restartTarget}`);
    const deniedAgain = await waitForSession(
      restarted.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.filter((event) => event.type === 'turn/end').length >=
          4 &&
        toolResults(candidate)
          .map(denialOf)
          .filter((entry) => entry !== null).length >= 2,
      120_000,
    );
    expect(deniedAgain).not.toBeNull();
    const recoveredSession = deniedAgain ?? deniedSession;
    const secondDenials = toolResults(recoveredSession)
      .map(denialOf)
      .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
    expect(secondDenials.length).toBeGreaterThanOrEqual(2);
    const second = secondDenials[1];
    if (second === undefined) throw new Error('no post-restart denial');
    expect(second.callId).not.toBe(denial.callId);
    expect(second.reason).toContain('deny-rule');
    await expect(readFile(restartTarget, 'utf8')).rejects.toThrow();
    // The post-restart refusal is attributed to the restored configuration.
    expect(decisionsFor(recoveredSession, second.callId)).toHaveLength(1);
    // The permission the plugin applied is the guarded boundary it reported,
    // so "recovered" did not quietly widen the session.
    expect(effectivePermission(recoveredSession.events).sandbox).not.toBe(
      'danger-full-access',
    );
    steps.add('denied-after-restart', {
      callId: second.callId,
      permission: effectivePermission(recoveredSession.events),
    });
  } finally {
    await testInfo.attach('acceptance-journey-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose().catch(() => undefined);
  }
});

/**
 * The plugin page is not a takeover surface.
 *
 * A separate short case because it needs the first-install composition (no
 * `arbiter` config row at all), which the journey case cannot also be: there
 * the rule must be saved, and here the point is that nothing is applied.
 */
test.describe('installation does not take over', () => {
  test('a bare install leaves the rule table empty and starts no gate', async ({
    page,
  }, testInfo) => {
    test.setTimeout(300_000);
    const caseHost: CaseHost = await createCaseHost(
      join(testInfo.outputPath('bare-install')),
      // `unset` omits the user configuration entirely: a real first install has
      // no `config` field on the plugin row, so seeding `{}` would only prove
      // that an explicit empty document works.
      { arbiterConfig: 'unset' },
    );
    try {
      const host = caseHost.current();
      // The profile document must really lack the configuration, otherwise the
      // rest of this case would be testing the wrong composition.
      const patch = await readFile(host.documentPath, 'utf8');
      expect(patch.trimStart().startsWith('[')).toBe(true);
      const parsed: unknown = JSON.parse(patch);
      expect(Array.isArray(parsed)).toBe(true);
      const rows: readonly unknown[] = Array.isArray(parsed) ? parsed : [];
      const arbiterRow = rows.find(
        (row: unknown) => isRecord(row) && row['id'] === 'arbiter',
      );
      expect(arbiterRow).toBeDefined();
      expect(isRecord(arbiterRow) && 'config' in arbiterRow).toBe(false);
      const state = await readState(host);
      expect(state.rules).toEqual([]);
      expect(state.invalidConfigError).toBeNull();
      expect(state.modes).toMatchObject({ main: 'normal', subagent: 'strict' });
      expect(record(state.config, 'config')['boundary']).toBe('guarded');

      await openHost(page, host);
      await sendPrompt(page, 'BARE-INSTALL RUN echo bare-install-free');
      const session = await settledSession(host, 'BARE-INSTALL');
      // No admission and no verdict: an unmanaged session is not gated, which is
      // the same fact the market-facing claim rests on.
      expect(await admissionView(host, session.sessionId)).toMatchObject({
        enabled: false,
        managed: false,
      });
      expect(
        session.events.some(
          (event) => event.type === 'plugin:arbiter/decision',
        ),
      ).toBe(false);
      const call = toolResults(session).at(-1);
      expect(resultText(call ?? {})).toContain('bare-install-free');
      expect(denialOf(call ?? {})).toBeNull();
    } finally {
      await caseHost.dispose().catch(() => undefined);
    }
  });
});
