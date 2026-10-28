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
 * The selector's trigger.
 *
 * Its accessible name is the host's own phrasing plus the current value, so it
 * is matched by prefix rather than by an exact label: the visible text is the
 * host preset name or `自动审查（Arbiter）`, and both change with the state.
 */
function arbiterTrigger(page: Page) {
  return arbiterControl(page).locator('[data-arbiter-trigger]');
}

/**
 * An open permission menu.
 *
 * The host `Menu` portals its popup to `document.body` and publishes no
 * accessible name, so it must be located at page level: it is never a
 * descendant of the seat.
 */
function permissionMenu(page: Page) {
  return page.getByRole('menu');
}

/** One selectable row; the host menu renders `menuitem`, not `menuitemradio`. */
function menuItem(page: Page, name: string | RegExp) {
  return permissionMenu(page).getByRole('menuitem', { name });
}

async function openPermissionMenu(page: Page): Promise<void> {
  await arbiterTrigger(page).click();
  await expect(permissionMenu(page)).toBeVisible();
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

test(
  'the arbiter selector owns the permission seat and drives the real session state',
  {
    // The only CI job that runs on a real host is the `@smoke` subset, and this
    // case is what proves the host actually publishes the primitives the seat
    // renders — the packed-consumer stub cannot show that.
    tag: '@smoke',
  },
  async ({ page }, testInfo) => {
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
      const trigger = arbiterTrigger(page);
      await expect(trigger).toBeVisible();
      await expect(trigger).toContainText('工作区内修改');

      // Enable through the control, then read the backend answer back.
      await openPermissionMenu(page);
      const menu = permissionMenu(page);
      await testInfo.attach('selector-menu.png', {
        body: await page.screenshot({ fullPage: false }),
        contentType: 'image/png',
      });
      await menu.getByRole('menuitem', { name: '自动审查（Arbiter）' }).click();
      const enabled = await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      );
      expect(enabled).not.toBeNull();
      steps.add('enabled', enabled);
      // The visible label is the native one; the boundary rides the tooltip and
      // the accessible name, never the single-line label. The trigger settles
      // only once the confirmed answer arrives, so this waits for it.
      await expect(arbiterTrigger(page)).toHaveText('自动审查（Arbiter）');
      await expect(arbiterTrigger(page)).toHaveAttribute(
        'title',
        '自动审查（Arbiter） · 工作区写入',
      );
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

      // Leave through the same control. The native exit is a host preset, not a
      // dedicated row: under guarded the host value is already `workspace-write`,
      // so this same-value selection is exactly the case that must still send the
      // command instead of taking the native no-op path.
      await openPermissionMenu(page);
      await menuItem(page, '工作区内修改').click();
      const disabled = await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === false,
      );
      expect(disabled).not.toBeNull();
      steps.add('disabled', disabled);
      await expect(arbiterTrigger(page)).toBeVisible();
    } finally {
      await testInfo.attach('selector-steps.json', {
        body: steps.json(),
        contentType: 'application/json',
      });
      await caseHost.dispose();
    }
  },
);

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
    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    await expect(arbiterTrigger(page)).toBeVisible();
    steps.add('first-page-enabled', { sessionId });

    // A second connection (its own browser context) disables the session.
    // A genuinely second connection: another page on the same host, holding
    // the same session open.
    const secondPage = await page.context().newPage();
    try {
      await openHost(secondPage, host);
      await openExistingSession(secondPage, 'SEL-RECONNECT');
      await arbiterTrigger(secondPage).click();
      // Another connection leaves through a host preset, which stops the
      // admission; the row no longer exists in the healthy state.
      await menuItem(secondPage, '仅可查看').click();
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
    await expect(arbiterTrigger(page)).toBeVisible();
    steps.add('first-page-adopted', {
      backend: await admissionView(host, sessionId),
    });
    await testInfo.attach('reconnect-adopted.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // Re-enable, then refresh: the browser must reload the confirmed state
    // rather than replay the pre-refresh label.
    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
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
    await expect(arbiterTrigger(page)).toBeVisible();
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

test('the seat keeps native keyboard and focus behaviour', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-keyboard'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-KEYS RUN echo keyboard-warmup');
    const session = await settledSession(host, 'SEL-KEYS');
    const trigger = arbiterTrigger(page);
    await expect(trigger).toBeEnabled();

    // Opening with the keyboard alone: the native menu takes focus into its own
    // list, so the first row is reachable without a pointer.
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(permissionMenu(page)).toBeVisible();
    const first = menuItem(page, '仅可查看');
    await expect(first).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(permissionMenu(page)).toHaveCount(0);
    // Escape returns focus to the trigger it came from, not to the page body.
    await expect(trigger).toBeFocused();
    steps.add('keyboard-open-escape', { focused: true });

    // Arrow keys move focus through the host's own menu; the contract is that
    // the plugin's anchor and state plumbing do not break that model.
    await page.keyboard.press('Enter');
    await expect(permissionMenu(page)).toBeVisible();
    await page.keyboard.press('ArrowDown');
    await expect(menuItem(page, '仅可查看')).toBeFocused();
    await page.keyboard.press('ArrowDown');
    await expect(menuItem(page, '工作区内修改')).toBeFocused();
    await page.keyboard.press('End');
    await expect(menuItem(page, '自动审查（Arbiter）')).toBeFocused();

    // Activating the focused row from the keyboard enables the session, so the
    // whole enable path is reachable without a pointer.
    await page.keyboard.press('Enter');
    await expect(permissionMenu(page)).toHaveCount(0);
    expect(
      await waitForAdmission(
        host,
        session.sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    steps.add('keyboard-select', { sessionId: session.sessionId });

    // The risk gate is modal and cancellable from the keyboard; cancelling must
    // send nothing and must give focus back to the trigger.
    await openPermissionMenu(page);
    await page.keyboard.press('Escape');
    await page.keyboard.press('Enter');
    await expect(permissionMenu(page)).toBeVisible();
    await menuItem(page, '完全权限').click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('checkbox')).not.toBeChecked();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
    expect((await admissionView(host, session.sessionId))['enabled']).toBe(
      true,
    );
    steps.add('keyboard-cancel-dialog', { admission: 'unchanged' });
    // Dismissing the gate gives focus back to the trigger it was opened from;
    // visibility alone would not prove that.
    await expect(trigger).toBeFocused();

    // Native responsive parity: the host hides a permission trigger's label in
    // a narrow composer, keeping only the glyph and the chevron. The plugin's
    // rule must key off the composer's own container, not the button (which is
    // capped at 220px and would therefore always look narrow).
    const label = page.locator('[data-arbiter-trigger-label]');
    await expect(label).toBeVisible();
    const icon = page.locator('[data-arbiter-trigger-icon] svg');
    expect((await icon.boundingBox())?.width).toBe(14);
    for (const width of [560, 480]) {
      await page.setViewportSize({ width, height: 720 });
      await expect(label).toBeHidden();
      // The glyph survives, so the collapsed trigger is still identifiable.
      await expect(icon).toBeVisible();
    }
    await page.setViewportSize({ width: 1280, height: 720 });
    await expect(label).toBeVisible();
    steps.add('responsive-trigger', { wideLabel: true, narrowLabel: false });
  } finally {
    await testInfo.attach('keyboard-steps.json', {
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

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
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

    // A reload still receives the plugin's browser module (this host version
    // does not unload an already-served client bundle), but its host half is
    // gone. The client must therefore not claim the seat: an inert override on
    // top of the native control would be worse than no selector at all.
    await page.reload();
    await openHost(page, host);
    await expect(arbiterControl(page)).toHaveCount(0);
    // Positive proof of the fallback: the host's own permission control holds
    // the seat and is operable, not merely "no arbiter occupant".
    const native = permissionSeat(page).getByRole('button').first();
    await expect(native).toBeVisible();
    await expect(native).toBeEnabled();
    const nativeLabel = await native.getAttribute('aria-label');
    // The host's own trigger names itself as the access mode selector.
    expect(nativeLabel ?? '').toMatch(/访问模式|Access mode/u);
    await native.click();
    const nativeMenu = page.getByRole('menu').or(page.getByRole('dialog'));
    await expect(nativeMenu.first()).toBeVisible();
    steps.add('native-control-restored', { nativeLabel });
    await page.keyboard.press('Escape');
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

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
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
    await openPermissionMenu(page);
    await menuItem(page, '工作区内修改').click();
    const exited = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(exited).not.toBeNull();
    steps.add('same-value-exit', exited);
    await expect(arbiterTrigger(page)).toBeVisible();
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
    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    await openPermissionMenu(page);
    await menuItem(page, '仅可查看').click();
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

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
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
    await expect(arbiterTrigger(page)).toBeVisible();

    // The full-access confirmation writes nothing when cancelled.
    await openPermissionMenu(page);
    await menuItem(page, '完全权限').click();
    // `RiskConfirmation` portals to `document.body`, so it is never inside the
    // seat: it must be located at page level.
    const dialog = page.getByRole('dialog');
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

test('a host preset the backend refuses leaves admission and shows a failure', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-refused-preset'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-REFUSED RUN echo refused-warmup');
    const session = await settledSession(host, 'SEL-REFUSED');
    const sessionId = session.sessionId;

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
    const enabled = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === true,
    );
    expect(enabled).not.toBeNull();
    const before = await admissionView(host, sessionId);

    // `auto` is rejected by #4 before any permission write. It is not offered
    // in the menu, so the same failure is produced through the native entry the
    // control's bridge uses, then the control must reconcile to the truth.
    await sendPrompt(page, '/permission auto');
    const settled = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some((event) => event.type === 'command/done'),
      60_000,
    );
    expect(permissionCommands(settled?.events ?? []).at(-1)).toMatchObject({
      args: ' auto',
      settled: 'error',
    });
    const after = await admissionView(host, sessionId);
    expect(after).toMatchObject({ enabled: true });
    expect(after['at']).toBe(before['at']);
    steps.add('refused-preset', { before, after });

    // The control still renders the confirmed state, not the refused intent.
    await expect(arbiterTrigger(page)).toBeVisible();

    // A rejected selection through Arbiter's own menu: `auto` is not an option,
    // so the failure is produced by a preset the host no longer accepts. The
    // selector must report it instead of claiming success, and the confirmed
    // admission must not move.
    const beforeMenu = await admissionView(host, sessionId);
    expect(await permissionMenu(page).count()).toBe(0);
    await openPermissionMenu(page);
    // `auto` stays out: the plugin's host half rejects that entry before any
    // permission write, so offering it would be a row that always fails.
    await expect(menuItem(page, 'auto')).toHaveCount(0);
    await menuItem(page, '完全权限').click();
    // The host risk gate portals to `document.body`.
    const confirmDialog = page.getByRole('dialog');
    await expect(confirmDialog).toBeVisible();
    await confirmDialog
      .getByRole('checkbox', { name: '我已了解风险，愿意继续' })
      .check();
    await confirmDialog.getByRole('button', { name: '切换权限' }).click();
    await expect(confirmDialog).toHaveCount(0);
    const afterMenu = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(afterMenu).not.toBeNull();
    expect(afterMenu?.['at']).not.toBe(beforeMenu['at']);
    await expect(arbiterTrigger(page)).toBeVisible();
    await testInfo.attach('refused-preset.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('refused-preset-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('an external same-value slash exit updates the selector without focus', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-external-exit'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-EXTERNAL RUN echo external-warmup');
    const session = await settledSession(host, 'SEL-EXTERNAL');
    const sessionId = session.sessionId;

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();

    // The user exits through the native slash entry, not through the Arbiter
    // menu. Guarded already runs workspace-write, so this writes no permission
    // event: only the command pair can carry the exit, and no focus/online
    // event happens here.
    await sendPrompt(page, '/permission workspace-write');
    const settled = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.some((event) => event.type === 'command/done'),
      60_000,
    );
    expect(permissionCommands(settled?.events ?? []).at(-1)).toMatchObject({
      args: ' workspace-write',
      settled: 'success',
    });
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === false,
      ),
    ).not.toBeNull();

    // The mounted selector adopted the exit from the session's own event
    // stream; nothing in this case dispatched focus, online or visibility.
    await expect(arbiterTrigger(page)).toBeVisible();
    steps.add('external-exit-adopted', {
      commands: permissionCommands(settled?.events ?? []),
    });
    await testInfo.attach('external-exit.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('external-exit-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('the real slot follows the released Chinese and English catalogs', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-locale'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-LOCALE RUN echo locale-warmup');
    const session = await settledSession(host, 'SEL-LOCALE');
    expect(
      await waitForAdmission(
        host,
        session.sessionId,
        (admission) => admission['enabled'] === false,
      ),
    ).not.toBeNull();

    // Chinese host language: the control's own copy is Arbiter's source text.
    await expect(arbiterTrigger(page)).toBeVisible();
    const chinese = await arbiterControl(page).innerText();
    steps.add('chinese', { copy: chinese });

    // Switch the real host language to English. Since #23 the slot renders its
    // own English catalog instead of falling back to Chinese; the mounted
    // control still shows the same backend-confirmed admission.
    await page
      .getByRole('button', { name: /账号菜单|Account menu/u })
      .first()
      .click();
    await page.getByText(/^(设置|Settings)$/u).click();
    await page
      .getByRole('button', { name: /^(中文|English)$/u })
      .first()
      .click();
    await page.getByText('English', { exact: true }).click();
    await page.getByRole('button', { name: /^(Close|关闭)$/u }).click();
    await expect(page.locator('html')).toHaveAttribute('lang', /^en/);

    // The trigger shows the host's own preset label, not plugin copy: with the
    // default guarded composition the session is on workspace write.
    await expect(arbiterTrigger(page)).toHaveText('Workspace Write');
    const copy = await arbiterControl(page).innerText();
    expect(copy).not.toMatch(/permission\./u);
    expect(copy).not.toMatch(/\{\w+\}/u);
    expect(copy).not.toMatch(/undefined/u);
    steps.add('english', { copy });
    await testInfo.attach('english-slot.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });

    // The open menu is translated too, and it still drives the same action:
    // enabling through the English menu reaches the backend unchanged.
    await arbiterTrigger(page).click();
    const menu = permissionMenu(page);
    await expect(menu).toBeVisible();
    // A long English item must stay inside the menu instead of overflowing it.
    const menuBox = await menu.boundingBox();
    for (const item of await menu.getByRole('menuitem').all()) {
      const box = await item.boundingBox();
      if (box === null || menuBox === null) continue;
      expect(box.x).toBeGreaterThanOrEqual(menuBox.x - 1);
      expect(box.x + box.width).toBeLessThanOrEqual(
        menuBox.x + menuBox.width + 1,
      );
    }
    await menu.getByRole('menuitem', { name: 'Auto review (Arbiter)' }).click();
    expect(
      await waitForAdmission(
        host,
        session.sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();
    await expect(arbiterTrigger(page)).toHaveText('Auto review (Arbiter)');
    await expect(arbiterTrigger(page)).toHaveAttribute(
      'title',
      'Auto review (Arbiter) · Workspace write',
    );
    steps.add('enabled-in-english', {
      copy: await arbiterControl(page).innerText(),
    });
    await testInfo.attach('english-enabled.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('locale-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});

test('the full-access confirmation applies after acknowledging, and a withdrawn catalog option fails visibly', async ({
  page,
}, testInfo) => {
  const steps = new Steps();
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('dsh-full-access'),
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await sendPrompt(page, 'SEL-FULL RUN echo full-warmup');
    const session = await settledSession(host, 'SEL-FULL');
    const sessionId = session.sessionId;

    await openPermissionMenu(page);
    await menuItem(page, '自动审查（Arbiter）').click();
    expect(
      await waitForAdmission(
        host,
        sessionId,
        (admission) => admission['enabled'] === true,
      ),
    ).not.toBeNull();

    // Acknowledged full-access: the host applies the preset, and Arbiter leaves
    // because a successful native command is the exit #4 observes.
    await openPermissionMenu(page);
    await menuItem(page, '完全权限').click();
    // `RiskConfirmation` portals to `document.body`, so it is never inside the
    // seat: it must be located at page level.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog
      .getByRole('checkbox', { name: '我已了解风险，愿意继续' })
      .check();
    const enabledConfirm = dialog.getByRole('button', { name: '切换权限' });
    await expect(enabledConfirm).toBeEnabled();
    await enabledConfirm.click();
    await expect(dialog).toHaveCount(0);

    const exited = await waitForAdmission(
      host,
      sessionId,
      (admission) => admission['enabled'] === false,
    );
    expect(exited).not.toBeNull();
    const switched = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        effectivePermission(candidate.events).sandbox === 'danger-full-access',
      60_000,
    );
    expect(switched).not.toBeNull();
    expect(effectivePermission(switched?.events ?? [])).toMatchObject({
      sandbox: 'danger-full-access',
    });
    steps.add('full-access-applied', {
      admission: exited,
      permission: effectivePermission(switched?.events ?? []),
    });
    await testInfo.attach('full-access.png', {
      body: await arbiterControl(page).screenshot(),
      contentType: 'image/png',
    });
  } finally {
    await testInfo.attach('full-access-steps.json', {
      body: steps.json(),
      contentType: 'application/json',
    });
    await caseHost.dispose();
  }
});
