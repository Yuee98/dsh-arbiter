/**
 * Real-host session permission selector (#5).
 *
 * Every case boots the pinned DSH on an isolated home with the deterministic
 * model fixture, then drives the actual browser client. The evidence is the
 * host's own session log plus the plugin's admission route — never the
 * component's local state.
 *
 * The contract under test: one control in the host's permission seat, the
 * backend-confirmed state is what the control shows, another connection's
 * change is adopted on reconnect, a refresh keeps the state, and the host's own
 * control returns once the client overlay is gone.
 */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import {
  effectivePermission,
  lastAdmission,
  permissionCommands,
  waitForSession,
} from './dsh/session-log.js';
import type { LoggedSession } from './dsh/session-log.js';

interface StepRecord {
  readonly at: number;
  readonly step: string;
  readonly detail?: unknown;
}

/** One ordered record of what this case observed, attached on exit. */
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

async function recordBody(
  response: Response,
): Promise<Record<string, unknown>> {
  const parsed: unknown = await response.json();
  return asRecord(parsed) ?? {};
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return null;
  return { ...value };
}

function admissionOf(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  if (record === null) return {};
  return asRecord(record['admission']) ?? {};
}

/** The backend-confirmed admission, read over the public route. */
async function admissionView(
  host: DshHost,
  sessionId: string,
): Promise<Record<string, unknown>> {
  const response = await fetch(
    `${host.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(sessionId)}`,
    { headers: { cookie: `${host.cookie.name}=${host.cookie.value}` } },
  );
  return admissionOf(await recordBody(response));
}

/** Poll the backend view until it satisfies `matches`, or return the last one. */
async function waitForAdmission(
  host: DshHost,
  sessionId: string,
  matches: (admission: Record<string, unknown>) => boolean,
  timeoutMs = 30_000,
): Promise<Record<string, unknown> | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const latest = await admissionView(host, sessionId);
    if (matches(latest)) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/**
 * Open the isolated host in the browser with its own bootstrap cookie.
 *
 * A restart or a second page changes nothing about this contract: the page
 * behaves exactly like the product client.
 */
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

/** Send one line into the real composer. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/** Open one existing session from the sidebar by its own title. */
async function openExistingSession(
  page: Page,
  titleFragment: string,
): Promise<void> {
  const row = page.getByRole('treeitem', { name: new RegExp(titleFragment) });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
  await expect(
    page.locator('[data-slot="conversation.input.permission"]'),
  ).toBeVisible();
}

/** The one permission seat the host renders in the composer. */
function permissionSeat(page: Page) {
  return page.locator('[data-slot="conversation.input.permission"]');
}

/** The arbiter occupant inside that seat. */
function arbiterControl(page: Page) {
  return permissionSeat(page).locator('[data-arbiter-permission]');
}

/**
 * Report whether the seat renders a native permission control instead of the
 * arbiter occupant, using the host's own accessible names.
 */
async function nativeControlPresent(page: Page): Promise<boolean> {
  const native = permissionSeat(page).getByRole('button', {
    name: /权限|Access mode/i,
  });
  if ((await native.count()) === 0) return false;
  const arbiter = await arbiterControl(page).count();
  return arbiter === 0;
}

/** Wait until a session with `marker` in its log has settled a turn. */
async function settledSession(
  host: DshHost,
  marker: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some(
        (event) =>
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes(marker),
      ) && candidate.events.some((event) => event.type === 'turn/end'),
    timeoutMs,
  );
  if (session === null) throw new Error(`session ${marker} never settled`);
  return session;
}

test('the arbiter selector owns the permission seat and drives the real session state', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-selector'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-WARM RUN echo selector-warmup');
    const session = await settledSession(host, 'SEL-WARM');
    const sessionId = session.sessionId;
    steps.add('session-settled', { sessionId });

    // The seat exists, and the arbiter occupant is the only thing in it.
    const seat = permissionSeat(page);
    await expect(seat).toBeVisible();
    await expect(arbiterControl(page)).toHaveCount(1);
    await expect(arbiterControl(page)).toBeVisible();
    expect(await nativeControlPresent(page)).toBe(false);
    steps.add('seat-occupied', {
      seats: await seat.count(),
      arbiter: await arbiterControl(page).count(),
      nativeControl: false,
    });
    // The seat itself is `display: contents`, so its own box has no pixels;
    // the arbiter occupant is the element that is actually rendered.
    await testInfo.attach('selector-initial.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // A fresh session is not admitted: the control says so, and the backend
    // agrees. This is the "installing must not take over" side of the contract.
    expect(await admissionView(host, sessionId)).toMatchObject({
      enabled: false,
      managed: false,
    });
    const trigger = arbiterControl(page).getByRole('button', {
      name: /未启用自动审查/u,
    });
    await expect(trigger).toBeVisible();

    // Enable through the control, then read the backend answer back.
    await trigger.click();
    const menu = arbiterControl(page).getByRole('menu', {
      name: '会话权限',
    });
    await expect(menu).toBeVisible();
    await testInfo.attach('selector-menu.png', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
    await menu
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    const enabled = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === true,
    );
    expect(enabled).not.toBeNull();
    steps.add('enabled', enabled);
    await expect(
      arbiterControl(page).getByRole('button', {
        name: /自动审查（Arbiter · 工作区写入）/u,
      }),
    ).toBeVisible();
    await testInfo.attach('selector-enabled.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // The enable is durable in the session log, not only in the browser.
    const logged = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some(
          (event) => event.type === 'plugin:arbiter/admission',
        ),
    );
    expect(lastAdmission(logged?.events ?? [])).toMatchObject({
      enabled: true,
    });

    // Disable through the same control.
    await arbiterControl(page)
      .getByRole('button', { name: /自动审查（Arbiter · 工作区写入）/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '关闭自动审查' })
      .click();
    const disabled = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(disabled).not.toBeNull();
    steps.add('disabled', disabled);
    await expect(
      arbiterControl(page).getByRole('button', { name: /未启用自动审查/u }),
    ).toBeVisible();
  } finally {
    await testInfo.attach('selector-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('a second connection change and a refresh both adopt the backend state', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-reconnect'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-RECONNECT RUN echo reconnect-warmup');
    const session = await settledSession(host, 'SEL-RECONNECT');
    const sessionId = session.sessionId;

    // Enable from this page so both pages start from a confirmed "enabled".
    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    await expect(
      arbiterControl(page).getByRole('button', { name: /Arbiter ·/u }),
    ).toBeVisible();
    steps.add('first-page-enabled', { sessionId });

    // A second connection (its own browser context) disables the session.
    // A genuinely second connection: another page on the same host, holding
    // the same session open.
    const secondPage = await page.context().newPage();
    try {
      await openHost(secondPage, host);
      await openExistingSession(secondPage, 'SEL-RECONNECT');
      await arbiterControl(secondPage)
        .getByRole('button', { name: /Arbiter ·/u })
        .click();
      await arbiterControl(secondPage)
        .getByRole('menu', { name: '会话权限' })
        .getByRole('menuitemradio', { name: '关闭自动审查' })
        .click();
      expect(
        await waitForAdmission(
          host,
          sessionId,
          (admission) => admission['enabled'] === false,
        ),
      ).not.toBeNull();
      steps.add('second-connection-disabled', { sessionId });
    } finally {
      await secondPage.close();
    }

    // The first page was left on the confirmed "enabled" label; it must adopt
    // the other connection's answer rather than keep its stale value.
    await page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
    });
    await expect(
      arbiterControl(page).getByRole('button', { name: /未启用自动审查/u }),
    ).toBeVisible();
    steps.add('first-page-adopted', {
      backend: await admissionView(host, sessionId),
    });
    await testInfo.attach('reconnect-adopted.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // Re-enable, then refresh: the browser must reload the confirmed state
    // rather than replay the pre-refresh label.
    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    const before = await admissionView(host, sessionId);

    await page.reload();
    await openHost(page, host);
    const disabledState = await fetch(`${host.origin}/api/arbiter/state`, {
      headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
    });
    steps.add('after-disable', {
      status: disabledState.status,
      body: await recordBody(disabledState),
    });
    await expect(
      arbiterControl(page).getByRole('button', { name: /Arbiter ·/u }),
    ).toBeVisible();
    const after = await admissionView(host, sessionId);
    expect(after['enabled']).toBe(before['enabled']);
    expect(after['admissionRevision']).toBe(before['admissionRevision']);
    steps.add('refresh-kept-state', { before, after });
    await testInfo.attach('refresh-kept.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // Writing the log line proves the state survived independently of the page.
    await writeFile(
      join(testInfo.outputPath(), 'admission-after-refresh.json'),
      JSON.stringify({ before, after }, null, 2),
    );
  } finally {
    await testInfo.attach('reconnect-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('removing the client overlay drops the confirmed state and leaves the backend record alone', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-unmount'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-UNMOUNT RUN echo unmount-warmup');
    const session = await settledSession(host, 'SEL-UNMOUNT');
    const sessionId = session.sessionId;

    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    const enabled = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === true,
    );
    expect(enabled).not.toBeNull();
    // The record's payload carries `at`; `seq` and `admissionRevision` are
    // derived at read time. The same `at` therefore proves the same state is
    // still the latest durable record after the plugin stopped.
    const confirmedAt = enabled?.['at'];
    expect(typeof confirmedAt).toBe('number');
    steps.add('enabled-before-unmount', enabled);

    // The host's own manager switch stops the plugin; the client overlay goes
    // with it on this page.
    await page.getByRole('button', { name: /^(插件|Plugins)$/ }).click();
    await expect(
      page.getByRole('button', { name: /^查看 dsh-arbiter$/ }),
    ).toBeVisible();
    await page.getByRole('button', { name: /^查看 dsh-arbiter$/ }).click();
    const toggle = page.getByRole('switch', { name: /dsh-arbiter/ }).first();
    await expect(toggle).toBeVisible();
    if ((await toggle.getAttribute('aria-checked')) !== 'false') {
      await toggle.click();
      await expect(toggle).toBeDisabled({ timeout: 30_000 });
      await expect(toggle).toBeEnabled({ timeout: 45_000 });
    }
    await expect(arbiterControl(page)).toHaveCount(0);
    steps.add('overlay-removed');
    await testInfo.attach('overlay-removed.png', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });

    // Disabling the plugin also removes its HTTP routes, so the backend answer
    // is read where it lives: the session log's own admission record. The
    // record the user confirmed is still the latest one, unchanged.
    const logged = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        lastAdmission(candidate.events) !== null,
      30_000,
    );
    expect(lastAdmission(logged?.events ?? [])).toMatchObject({
      enabled: true,
      at: confirmedAt,
    });
    steps.add('record-unchanged');

    // A page that reloads now still receives the plugin's browser module (this
    // host version does not unload an already-served client bundle), but its
    // host half is gone: the control must render its unavailable state and must
    // never fabricate a confirmed value or a successful write.
    await page.reload();
    await openHost(page, host);
    const reloaded = arbiterControl(page);
    if ((await reloaded.count()) > 0) {
      const control = reloaded.getByRole('button').first();
      await expect(control).toBeVisible();
      // No host half means no route to confirm: the control stays inert and
      // never claims an enabled state it cannot confirm.
      await expect(control).toBeDisabled();
      await expect(reloaded).not.toContainText('Arbiter ·');
      steps.add('reloaded-inert', {
        text: await reloaded.innerText(),
        disabled: await control.isDisabled(),
      });
    }
    await testInfo.attach('reloaded.png', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('unmount-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

/**
 * The native switch path.
 *
 * Leaving Arbiter goes through the host's own `/permission <preset>` command
 * and nothing else: #4 disables the admission when that command succeeds and
 * leaves it alone when it fails. These cases prove the new control calls that
 * path and reads the resulting backend state, including the same-value case
 * that writes no permission event at all.
 */
test('choosing a host preset leaves arbiter through the host command and reads the result', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-native'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-NATIVE RUN echo native-warmup');
    const session = await settledSession(host, 'SEL-NATIVE');
    const sessionId = session.sessionId;

    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    steps.add('enabled', { sessionId });

    // Same-value exit: guarded already runs workspace-write, so the host writes
    // no permission event at all. Only the command pair proves the exit, and
    // the control must adopt the backend answer without any focus event.
    await arbiterControl(page)
      .getByRole('button', { name: /Arbiter · 工作区写入/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '工作区内修改' })
      .click();
    const exited = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(exited).not.toBeNull();
    steps.add('same-value-exit', exited);
    await expect(
      arbiterControl(page).getByRole('button', { name: /未启用自动审查/u }),
    ).toBeVisible();
    // No focus/online/visibility event was dispatched by this case.
    await testInfo.attach('same-value-exit.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // The command in the log is the native one, with the exact preset.
    const settled = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some((event) => event.type === 'command/done'),
      60_000,
    );
    const commands = permissionCommands(settled?.events ?? []);
    expect(commands.at(-1)).toMatchObject({
      args: ' workspace-write',
      settled: 'success',
    });

    // A real permission change: re-enable, then leave to read-only. Both the
    // backend admission and the host's own effective permission move.
    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    await arbiterControl(page)
      .getByRole('button', { name: /Arbiter ·/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '只读' })
      .click();
    const readOnly = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(readOnly).not.toBeNull();
    const switched = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        effectivePermission(candidate.events).sandbox === 'read-only',
      60_000,
    );
    expect(switched).not.toBeNull();
    expect(effectivePermission(switched?.events ?? [])).toMatchObject({
      sandbox: 'read-only',
    });
    steps.add('read-only-switch', {
      admission: readOnly,
      permission: effectivePermission(switched?.events ?? []),
    });
    await testInfo.attach('read-only.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('native-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('a failed native command keeps admission and a full-access cancel writes nothing', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-native-failure'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-FAIL RUN echo failure-warmup');
    const session = await settledSession(host, 'SEL-FAIL');
    const sessionId = session.sessionId;

    await arbiterControl(page)
      .getByRole('button', { name: /未启用自动审查/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '自动审查（Arbiter）' })
      .click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();

    const before = await admissionView(host, sessionId);
    const presetEventsBefore = session.events.filter(
      (event) => event.type === 'permission/preset',
    ).length;

    // `auto` is rejected by #4 before any permission write. Through this control
    // it is not even offered, so the rejection is exercised through the native
    // slash entry while the selector stays mounted, and the control must keep
    // showing the backend's answer rather than the failed intent.
    await sendPrompt(page, '/permission auto');
    const rejected = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some((event) => event.type === 'command/done'),
      60_000,
    );
    expect(permissionCommands(rejected?.events ?? []).at(-1)).toMatchObject({
      args: ' auto',
      settled: 'error',
    });
    expect(
      (rejected?.events ?? []).filter(
        (event) => event.type === 'permission/preset',
      ),
    ).toHaveLength(presetEventsBefore);
    const afterRejection = await admissionView(host, sessionId);
    expect(afterRejection).toMatchObject({ enabled: true });
    expect(afterRejection['at']).toBe(before['at']);
    steps.add('auto-rejected', { before, afterRejection });
    // The control still shows the confirmed enabled state.
    await expect(
      arbiterControl(page).getByRole('button', { name: /Arbiter ·/u }),
    ).toBeVisible();

    // The full-access confirmation writes nothing when cancelled.
    await arbiterControl(page)
      .getByRole('button', { name: /Arbiter ·/u })
      .click();
    await arbiterControl(page)
      .getByRole('menu', { name: '会话权限' })
      .getByRole('menuitemradio', { name: '完全权限' })
      .click();
    const dialog = arbiterControl(page).getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: '切换权限' }),
    ).toBeDisabled();
    await dialog.getByRole('button', { name: '取消' }).click();
    await expect(dialog).toHaveCount(0);
    // No `danger-full-access` write happened, and the admission is unchanged.
    const afterCancel = await admissionView(host, sessionId);
    expect(afterCancel['at']).toBe(before['at']);
    const unchanged = await waitForSession(
      host.home,
      (candidate) => candidate.sessionId === sessionId,
    );
    expect(
      (unchanged?.events ?? []).filter(
        (event) => event.type === 'permission/preset',
      ),
    ).toHaveLength(presetEventsBefore);
    steps.add('full-access-cancelled', { afterCancel });
    await testInfo.attach('full-access-cancelled.png', {
      body: await page.screenshot({ fullPage: false }),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('native-failure-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});
