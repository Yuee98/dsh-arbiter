/**
 * The session denial marker in a real host (#19).
 *
 * The evidence here is the host's own session log and its rendered DOM, never
 * the plugin's memory: a rule denial, a review denial, a human refusal and a
 * refused-after-allow case each run through the real `tools/pre-execute` chain
 * and the real browser client. What the marker must show, and what it must not
 * claim, is asserted on that surface:
 *
 *   - the orange Arbiter marker, the short reason and the detail entry appear
 *     beside the call they belong to, keyed by the same `callId`;
 *   - opening the detail reaches the same shared component the log list uses,
 *     and still explains a call whose audit row is absent;
 *   - the refusal reason reaches the agent, which keeps working in the same
 *     turn instead of the session stopping;
 *   - a call Arbiter allowed whose body then failed in the host sandbox shows
 *     the host's own failure and no Arbiter denial;
 *   - other calls running in parallel are not aborted by a denial, proven by
 *     their own committed results rather than by timing.
 */

import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession, type LoggedSession } from './dsh/session-log.js';

const FORMAT = 'arbiter-config-v2';

/**
 * Wait until one recorded model request contains `predicate`.
 *
 * The fixture writes one JSON file per conversation request, so the agent's
 * actual next request is a durable observation rather than a timing guess.
 */
async function waitForFile(
  directory: string,
  predicate: (text: string) => boolean,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = await readdir(directory).catch(() => [] as string[]);
    for (const file of files.sort()) {
      const text = await readFile(join(directory, file), 'utf8').catch(
        () => '',
      );
      if (predicate(text)) return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

/** A deny rule for the fixture's marked `bash` command. */
function denyCommandRule(id: string, pattern: string): Record<string, unknown> {
  return {
    id,
    scope: { tools: ['bash'] },
    conditions: [
      { target: 'argument', path: '$.command', kind: 'regex', pattern },
    ],
    verdict: 'deny',
  };
}

/** Open the isolated host with its own bootstrap cookie. */
async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  const preview = page.getByRole('dialog', { name: /预览版说明|Preview/i });
  if (await preview.isVisible().catch(() => false)) {
    await preview.getByRole('button', { name: /^(继续|Continue)$/ }).click();
  }
  const gettingStarted = page.getByRole('dialog', {
    name: /开始使用|Get started/i,
  });
  if (await gettingStarted.isVisible().catch(() => false)) {
    await gettingStarted
      .getByRole('button', { name: /^(关闭|Close)$/ })
      .click();
  }
}

/** Send one user turn through the host's own composer. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  await page
    .getByRole('button', { name: '新建会话', exact: true })
    .first()
    .click();
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/**
 * Reveal one settled Turn's process rows through the host's own controls.
 *
 * A completed Turn folds its calls behind two disclosures: the Turn-level
 * "worked / finished" control, then the step-process group header. Both are the
 * host's normal reading interactions, and the denial row is inside that group
 * because it carries the same Turn/Step placement as the call it marks — which
 * is exactly the behaviour this case needs to observe.
 */
async function revealTurnProcess(page: Page, callId: string): Promise<void> {
  // The group header is the first control inside the group root; the tool rows
  // and the denial row's own button are descendants, so scope the click to the
  // header instead of picking any button in the group.
  const state = () =>
    page.evaluate((id: string) => {
      const row = document.querySelector(`[data-arbiter-row="${id}"]`);
      const item = row?.closest('[data-turn-process-member]');
      const group = row?.closest('[data-step-process]');
      const body = group?.querySelector('[data-step-process-body]');
      const header = group?.querySelector(':scope > div:first-child button');
      return {
        hidden: item?.hasAttribute('hidden') ?? true,
        bodyHidden: body?.hasAttribute('hidden') ?? true,
        headerExpanded: header?.getAttribute('aria-expanded') ?? null,
      };
    }, callId);

  for (let attempt = 0; attempt < 8; attempt += 1) {
    const current = await state();
    if (!current.hidden && !current.bodyHidden) return;
    if (current.hidden) {
      // The completed Turn is folded at the Turn level first.
      const outer = page
        .getByRole('button', {
          name: /已完成，用时|进行中|Finished in|Worked/u,
        })
        .last();
      if (await outer.isVisible().catch(() => false))
        await outer.click({ timeout: 5000 }).catch(() => undefined);
      continue;
    }
    // Then the step-process group itself is collapsed.
    const header = page
      .locator('[data-step-process]')
      .last()
      .locator(':scope > div:first-child button')
      .first();
    if (await header.isVisible().catch(() => false))
      await header.click({ timeout: 5000 }).catch(() => undefined);
  }
}

/** Wait for the session carrying `marker` and for its turn to settle. */
async function settledSession(
  host: DshHost,
  marker: string,
  timeoutMs = 120_000,
): Promise<LoggedSession> {
  const started = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some((event) =>
        JSON.stringify(event.data).includes(marker),
      ),
    timeoutMs,
  );
  if (started === null) throw new Error(`no session carried ${marker}`);
  const settled = await waitForSession(
    host.home,
    (candidate) =>
      candidate.sessionId === started.sessionId &&
      candidate.events.some((event) => event.type === 'turn/end'),
    timeoutMs,
  );
  return settled ?? started;
}

/**
 * Whether one recorded result is a failure.
 *
 * The host records that on the tool message (`data.message.isError`), beside the
 * role and the call identity — not on the event data itself. Reading the wrong
 * level would let a failed-but-not-denied call pass as a success.
 */
function isFailedResult(result: Readonly<Record<string, unknown>>): boolean {
  const message = result['message'];
  if (typeof message !== 'object' || message === null) return false;
  const bag: Readonly<Record<string, unknown>> = { ...message };
  return bag['isError'] === true;
}

/** The text one recorded result carried, as the log stored it. */
function resultText(result: Readonly<Record<string, unknown>>): string {
  const message = result['message'];
  if (typeof message !== 'object' || message === null) return '';
  const bag: Readonly<Record<string, unknown>> = { ...message };
  const content = bag['content'];
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block: unknown) => {
      if (typeof block !== 'object' || block === null) return [];
      const blockBag: Readonly<Record<string, unknown>> = { ...block };
      return typeof blockBag['text'] === 'string' ? [blockBag['text']] : [];
    })
    .join('\n');
}

/**
 * The `callId` a recorded `tool/result` message names.
 *
 * Read through narrowed property bags only: the payload is untrusted JSON from
 * the session log, never a shape this test may assert.
 */
function recordedCallId(
  result: Readonly<Record<string, unknown>>,
): string | null {
  const message = result['message'];
  if (typeof message !== 'object' || message === null) return null;
  const bag: Readonly<Record<string, unknown>> = { ...message };
  const source = bag['source'];
  if (typeof source !== 'object' || source === null) return null;
  const sourceBag: Readonly<Record<string, unknown>> = { ...source };
  const callId = sourceBag['callId'];
  return typeof callId === 'string' ? callId : null;
}

/** One durable result with the turn/step it was committed in. */
interface PlacedResult {
  readonly result: Readonly<Record<string, unknown>>;
  readonly turn: number | null;
  readonly step: number | null;
  readonly callId: string | null;
}

/** Read one result's placement and call identity from the log envelope. */
function placeResult(result: Readonly<Record<string, unknown>>): PlacedResult {
  const turn = typeof result['turn'] === 'number' ? result['turn'] : null;
  const step = typeof result['step'] === 'number' ? result['step'] : null;
  const callId = recordedCallId(result);
  return { result, turn, step, callId };
}

/** The durable `tool/result` events of one session. */
function toolResults(
  session: LoggedSession,
): readonly Readonly<Record<string, unknown>>[] {
  return session.events
    .filter((event) => event.type === 'tool/result')
    .flatMap((event) => {
      const data: unknown = event.data;
      return typeof data === 'object' && data !== null ? [{ ...data }] : [];
    });
}

/** The Arbiter denial identity one result recorded, if it did. */
function denialOf(
  result: Readonly<Record<string, unknown>>,
): { readonly callId: string; readonly reason: string | null } | null {
  const error = result['error'];
  if (typeof error !== 'object' || error === null) return null;
  const record: Readonly<Record<string, unknown>> = { ...error };
  if (record['name'] !== 'ArbiterDeniedError') return null;
  if (record['code'] !== 'ARBITER_DENIED') return null;
  const callId = recordedCallId(result);
  if (callId === null) return null;
  return {
    callId,
    reason: typeof record['reason'] === 'string' ? record['reason'] : null,
  };
}

/** The turn that carried an Arbiter refusal, if the log already holds one. */
function refusalTurnOf(session: LoggedSession): number | null {
  for (const result of toolResults(session)) {
    if (denialOf(result) === null) continue;
    const turn = result['turn'];
    if (typeof turn === 'number') return turn;
  }
  return null;
}

/** Enable Arbiter for one session exactly as the permission selector will. */
async function enableSession(host: DshHost, sessionId: string): Promise<void> {
  const response = await fetch(`${host.origin}/api/arbiter/sessions`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, action: 'enable' }),
  });
  expect(response.status).toBe(200);
}

test.describe('session denial feedback', () => {
  test('a rule denial shows the Arbiter marker, its reason, and opens the shared detail', async ({
    page,
  }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('dsh-denial'),
      {
        arbiterRowConfig: {
          format: FORMAT,
          rules: [denyCommandRule('deny-marker', 'echo arbiter-denied.*')],
        },
      },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'DENY-MARKER RUN echo arbiter-denied-one');
      const first = await settledSession(host, 'DENY-MARKER');
      await enableSession(host, first.sessionId);

      // The refused call must be issued by a session Arbiter already manages;
      // a second turn keeps the same session and the same page.
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.click();
      await page.keyboard.insertText(
        'DENY-MARKER-2 RUN echo arbiter-denied-two',
      );
      await page.keyboard.press('Enter');

      // Wait for the refusal *and* the end of the turn that carried it: a log
      // read between the flushed result and the follow-up response would
      // otherwise be asserted against a turn the host has not closed yet.
      const gated = await waitForSession(
        host.home,
        (candidate) => {
          if (candidate.sessionId !== first.sessionId) return false;
          const refusedTurn = refusalTurnOf(candidate);
          return (
            refusedTurn !== null &&
            candidate.events.some(
              (event) =>
                event.type === 'turn/end' &&
                (typeof event.data === 'object' && event.data !== null
                  ? Reflect.get(event.data, 'turn')
                  : null) === refusedTurn,
            )
          );
        },
        120_000,
      );
      expect(gated).not.toBeNull();
      const session = gated ?? first;

      // The log proves a real Arbiter refusal with the stage that decided it.
      const denials = toolResults(session)
        .map(denialOf)
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null);
      expect(denials).toHaveLength(1);
      const denial = denials[0];
      if (denial === undefined) throw new Error('no Arbiter denial recorded');
      // The recorded reason names the stage that decided it, so the row and the
      // agent agree about who refused.
      expect(denial.reason).toContain('deny-rule');
      expect(denial.reason).toContain('a deny rule matched this call');

      // Reveal the settled Turn's process rows first. The row carries the same
      // Turn/Step placement as the call it belongs to, so the host's own
      // "worked" disclosure contains it — that shared membership is what makes
      // it a marker on this call rather than a session-level notice.
      await revealTurnProcess(page, denial.callId);
      // The row is now inside a rendered Turn body, not merely in the DOM.
      await expect(
        page.locator(`[data-arbiter-row="${denial.callId}"]`),
      ).toBeVisible();

      // The marker renders in the real conversation at that call position.
      const marker = page.locator('[data-arbiter-denial]');
      await expect(marker).toHaveCount(1);
      await expect(marker).toHaveAttribute('data-arbiter-denial', 'rule');
      await expect(marker).toHaveAttribute('data-call-id', denial.callId);
      await expect(marker).toContainText('Arbiter 已拒绝');
      await expect(marker).toContainText('规则拒绝');
      // The short reason is the recorded one, quoted rather than paraphrased.
      await expect(marker).toContainText('a deny rule matched this call');
      const row = page.locator(`[data-arbiter-row="${denial.callId}"]`);
      await expect(row).toHaveCount(1);

      // The refusal is inline: no dialog and no toast was raised for it.
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(page.getByRole('alert')).toHaveCount(0);

      // The detail entry opens the same component the log list opens, for this
      // exact call id.
      await page.locator('[data-arbiter-row] button').click({ timeout: 8000 });
      await expect(page.getByText(`调用详情 · ${denial.callId}`)).toBeVisible();
      // The session record is the minimal verdict: the shared panel must say
      // which layers are missing instead of rendering an empty detail.
      await expect(
        page.getByRole('region', { name: '最终裁决' }),
      ).toBeVisible();
    } finally {
      await caseHost.dispose();
    }
  });

  test('the refusal reason reaches the agent, and parallel calls keep running', async ({
    page,
  }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('dsh-parallel'),
      {
        arbiterRowConfig: {
          format: FORMAT,
          rules: [
            denyCommandRule('deny-parallel', 'echo arbiter-parallel-denied.*'),
          ],
        },
        requestDir: join(testInfo.outputPath('dsh-parallel'), 'requests'),
      },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'PAR-WARM RUN echo arbiter-parallel-warm');
      const warm = await settledSession(host, 'PAR-WARM');
      await enableSession(host, warm.sessionId);

      // Two independent calls in one assistant step: the fixture issues one
      // `bash` call per marker, so this turn asks for a denied call and an
      // allowed one back to back.
      const composer = page.locator('[contenteditable="true"]').first();
      await composer.click();
      // One assistant step, two independent calls: the denied one and an
      // allowed one the host still executes.
      await page.keyboard.insertText(
        'PAR-ONE RUN echo arbiter-parallel-denied-one\nPAR-TWO RUN2 echo arbiter-parallel-allowed-two',
      );
      await page.keyboard.press('Enter');

      // Observable evidence, not a sleep: wait until this session records both
      // the refused result and a second, *executed* result.
      const both = await waitForSession(
        host.home,
        (candidate) => {
          if (candidate.sessionId !== warm.sessionId) return false;
          const placed = toolResults(candidate).map(placeResult);
          // One step holding both a refused call and an executed one: the
          // denial and the surviving call are in the same assistant step, so no
          // earlier warm-up turn can satisfy this predicate.
          const refusedInStep = placed.filter((entry) => {
            if (denialOf(entry.result) === null) return false;
            return placed.some(
              (executed) =>
                denialOf(executed.result) === null &&
                !isFailedResult(executed.result) &&
                executed.turn === entry.turn &&
                executed.step === entry.step &&
                executed.callId !== entry.callId,
            );
          });
          // The turn that carried the refusal must also be closed in this read,
          // so the later completion assertion never inspects a half-written log.
          return refusedInStep.some(
            (entry) =>
              entry.turn !== null &&
              candidate.events.some(
                (event) =>
                  event.type === 'turn/end' &&
                  (typeof event.data === 'object' && event.data !== null
                    ? Reflect.get(event.data, 'turn')
                    : null) === entry.turn,
              ),
          );
        },
        120_000,
      );
      expect(both).not.toBeNull();
      const session = both ?? warm;

      const placed = toolResults(session).map(placeResult);
      const refusedPlaced = placed.filter(
        (entry) => denialOf(entry.result) !== null,
      );
      expect(refusedPlaced.length).toBeGreaterThanOrEqual(1);
      const refusal = refusedPlaced[0];
      if (refusal === undefined) throw new Error('no refusal in this step');
      // The allowed call in the very same step committed its own successful
      // result, so the denial stopped only the call it refused.
      const sibling = placed.find(
        (entry) =>
          denialOf(entry.result) === null &&
          !isFailedResult(entry.result) &&
          entry.turn === refusal.turn &&
          entry.step === refusal.step &&
          entry.callId !== refusal.callId,
      );
      expect(sibling).toBeDefined();
      if (sibling === undefined) throw new Error('no sibling call in step');
      expect(sibling.callId).not.toBe(refusal.callId);

      // The sibling genuinely executed: it recorded output of its own command,
      // so "parallel calls keep running" is not inferred from a silent success.
      expect(resultText(sibling.result)).toContain(
        'arbiter-parallel-allowed-two',
      );

      // The denial belongs to this turn, and *this* turn reached its own end
      // event: a warm-up turn's `turn/end` must not satisfy this.
      expect(refusal.turn).not.toBeNull();
      const endedTurn = session.events.some((event) => {
        if (event.type !== 'turn/end') return false;
        const data: unknown = event.data;
        return (
          typeof data === 'object' &&
          data !== null &&
          Reflect.get(data, 'turn') === refusal.turn
        );
      });
      expect(endedTurn).toBe(true);

      // The agent received the refusal text and went on: the tool result the
      // model saw carries the stage tag, not an empty or generic error.
      const refusedTexts = refusedPlaced.map((entry) =>
        resultText(entry.result),
      );
      expect(refusedTexts.some((text) => text.includes('Not executed'))).toBe(
        true,
      );
      expect(refusedTexts.some((text) => text.includes('deny-rule'))).toBe(
        true,
      );
      // The next model request proves the reason reached the agent.
      const nextRequest = await waitForFile(
        join(testInfo.outputPath('dsh-parallel'), 'requests'),
        (text) => text.includes('Not executed') || text.includes('deny-rule'),
        120_000,
      );
      expect(nextRequest).toBe(true);

      // Only the refused call has a marker; the executed one has none.
      await expect(page.locator('[data-arbiter-denial]')).toHaveCount(1);
    } finally {
      await caseHost.dispose();
    }
  });

  test('an allowed call that the host sandbox refused is not shown as an Arbiter denial', async ({
    page,
  }, testInfo) => {
    // No deny rule: the call is allowed by Arbiter and then refused by the
    // host's own sandbox, which is the host's failure to present.
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('dsh-sandbox'),
      {
        arbiterRowConfig: { format: FORMAT, rules: [] },
        requestDir: join(testInfo.outputPath('dsh-sandbox'), 'requests'),
      },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'SBX-WARM RUN echo arbiter-sandbox-warm');
      const warm = await settledSession(host, 'SBX-WARM');
      await enableSession(host, warm.sessionId);

      const outside = join(testInfo.outputPath('dsh-sandbox'), 'outside.txt');
      await mkdir(join(testInfo.outputPath('dsh-sandbox')), {
        recursive: true,
      });
      await writeFile(outside, 'seed', 'utf8').catch(() => undefined);

      const composer = page.locator('[contenteditable="true"]').first();
      await composer.click();
      // A write outside the workspace: guarded mode confines it, the host
      // reports the failure, and Arbiter has already allowed the call.
      await page.keyboard.insertText(
        `SBX-OUT RUN printf 'x' > ~/arbiter-e2e-outside-${String(Date.now())}.txt`,
      );
      await page.keyboard.press('Enter');

      // Wait for this turn's result, then read the verdict Arbiter really
      // recorded for that exact call rather than guessing which allow shape it
      // produced (a rule allow and a review allow are different results).
      const settled = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === warm.sessionId &&
          (() => {
            const results = toolResults(candidate).map(placeResult);
            return results.some((entry) => {
              if (entry.callId === null) return false;
              const id: string = entry.callId;
              return candidate.events.some(
                (event) =>
                  event.type === 'plugin:arbiter/decision' &&
                  JSON.stringify(event.data).includes(`"callId":"${id}"`),
              );
            });
          })(),
        120_000,
      );
      expect(settled).not.toBeNull();
      const session = settled ?? warm;

      const results = toolResults(session).map(placeResult);
      // The out-of-workspace write is the call this case is about: the one whose
      // own callId also appears in an Arbiter decision record.
      const arbitrated = results.filter((entry) => {
        if (entry.callId === null) return false;
        const id: string = entry.callId;
        return session.events.some(
          (event) =>
            event.type === 'plugin:arbiter/decision' &&
            JSON.stringify(event.data).includes(`"callId":"${id}"`),
        );
      });
      expect(arbitrated.length).toBeGreaterThanOrEqual(1);
      const target = arbitrated[arbitrated.length - 1];
      if (target === undefined || target.callId === null)
        throw new Error('no arbitrated call was recorded');

      // Arbiter's own verdict for this call was not a denial...
      const targetId: string = target.callId;
      const decisions = session.events
        .filter(
          (event) =>
            event.type === 'plugin:arbiter/decision' &&
            JSON.stringify(event.data).includes(`"callId":"${targetId}"`),
        )
        .map((event) => JSON.stringify(event.data));
      expect(decisions.length).toBe(1);
      for (const denialResult of [
        '"result":"deny"',
        '"result":"review-deny"',
        '"result":"human-deny"',
        '"result":"human-abort"',
        '"result":"fallback-deny"',
      ]) {
        expect(decisions[0]).not.toContain(denialResult);
      }
      // ...and no Arbiter denial identity was recorded for it.
      expect(denialOf(target.result)).toBeNull();

      // The call Arbiter allowed really was refused by the host's own sandbox:
      // the recorded output carries the host denial and a non-zero exit, so this
      // case proves a real execution failure exists rather than passing because
      // nothing failed. Bash reports that as a normal command result, which is
      // exactly why it must not be relabelled as an approval refusal.
      const output = JSON.stringify(target.result);
      expect(output).toContain('sandbox');
      expect(output).toContain('Operation not permitted');
      // The structured error identity, when one was recorded, is never Arbiter's.
      const error = target.result['error'];
      if (typeof error === 'object' && error !== null) {
        const identity: Readonly<Record<string, unknown>> = { ...error };
        expect(identity['name']).not.toBe('ArbiterDeniedError');
        expect(identity['code']).not.toBe('ARBITER_DENIED');
      }

      // So the UI shows the host's own failure and no Arbiter denial marker.
      await expect(page.locator('[data-arbiter-denial]')).toHaveCount(0);
    } finally {
      await caseHost.dispose();
    }
  });
});
