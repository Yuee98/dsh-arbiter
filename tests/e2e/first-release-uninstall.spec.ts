/**
 * The real uninstall path on the pinned host (#23 acceptance item 2).
 *
 * The historical uninstall evidence is from DSH 0.2.1-rc.2. This case re-runs
 * the *product* lifecycle on the version the release actually pins: uninstalling
 * the plugin through the host's own plugin manager, then checking the three
 * facts the delivery note promises — the plugin stops deciding, the routes are
 * gone, and a restart does not bring it back — plus the state it must not
 * destroy (the settings file and the audit database stay).
 *
 * It is deliberately one focused case: the in-flight/drain-window behaviour is
 * already owned by `session-admission.spec.ts`, and this does not repeat it.
 */
import { access } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession } from './dsh/session-log.js';

const FORMAT = 'arbiter-config-v2';

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

/** Send one line into the real composer. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/** Whether an HTTP route answers at all, without asserting its body. */
async function routeStatus(host: DshHost, path: string): Promise<number> {
  const response = await fetch(`${host.origin}${path}`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  return response.status;
}

test('uninstalling through the plugin manager stops the gate and survives a restart', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const caseHost = await createCaseHost(
    testInfo.outputPath('first-release-uninstall'),
    {
      arbiterRowConfig: {
        format: FORMAT,
        rules: [
          {
            id: 'uninstall-deny',
            scope: { tools: ['bash'] },
            conditions: [
              {
                target: 'argument',
                path: '$.command',
                kind: 'regex',
                pattern: 'touch .*uninstall-denied\\.txt',
              },
            ],
            verdict: 'deny',
          },
        ],
      },
    },
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);

    // A real turn establishes the session, then the plugin is enabled and the
    // rule really refuses a call. This is the "before" state a removal must end.
    await sendPrompt(page, 'UNINSTALL-WARM RUN echo uninstall-warmup');
    const warm = await waitForSession(
      host.home,
      (candidate) =>
        candidate.events.some((event) => event.type === 'turn/end'),
      120_000,
    );
    expect(warm).not.toBeNull();
    const sessionId = warm?.sessionId;
    expect(typeof sessionId).toBe('string');
    if (sessionId === undefined) throw new Error('no session id');

    const enable = await fetch(`${host.origin}/api/arbiter/sessions`, {
      method: 'POST',
      headers: {
        cookie: `${host.cookie.name}=${host.cookie.value}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId, action: 'enable' }),
    });
    expect(enable.status).toBe(200);
    expect(await routeStatus(host, '/api/arbiter/state')).toBe(200);

    // The settings file and the audit database exist before removal, so the
    // "state is preserved" assertion afterwards is about preservation and not
    // about a directory that was never written.
    await expect(access(host.documentPath)).resolves.toBeUndefined();
    const auditPath = join(host.home, 'arbiter', 'arbiter.db');
    await expect(access(auditPath)).resolves.toBeUndefined();

    // ---- The real uninstall, through the host's own plugin manager --------
    await page
      .getByRole('button', { name: /^(插件|Plugins)$/u })
      .first()
      .click();
    await page
      .getByRole('button', { name: /^(查看|View) dsh-arbiter$/u })
      .click();
    await expect(page.locator('[data-arbiter-root]')).toBeVisible();
    await page.getByRole('button', { name: /^(卸载|Uninstall)/u }).click();
    // A removal is destructive, so the host asks first. Confirming is the
    // operator's own action; there is no API shortcut in this case.
    const confirm = page.getByRole('dialog').getByRole('button', {
      name: /^(卸载|Uninstall|确认|Confirm|删除|Remove)/u,
    });
    if (await confirm.isVisible().catch(() => false)) await confirm.click();

    // The plugin's public surface is gone: the state route no longer answers.
    await expect
      .poll(async () => routeStatus(host, '/api/arbiter/state'), {
        timeout: 60_000,
      })
      .not.toBe(200);
    // The configuration page is gone too, so nothing can be edited silently.
    await expect(page.locator('[data-arbiter-root]')).toHaveCount(0);

    // The files it did not own are preserved: an uninstall must not delete the
    // user's settings document or the audit database behind their back.
    await expect(access(host.documentPath)).resolves.toBeUndefined();
    await expect(access(auditPath)).resolves.toBeUndefined();

    // ---- Restart does not resurrect the removed plugin -------------------
    // The plugin was just uninstalled, so the next start must observe its
    // absence rather than be repaired by the fixture.
    const restarted = await caseHost.restart({ pluginRemoved: true });
    expect(await routeStatus(restarted, '/api/arbiter/state')).not.toBe(200);
    await openHost(page, restarted);
    await page
      .getByRole('button', { name: /^(插件|Plugins)$/u })
      .first()
      .click();
    // The plugin row is absent, and the host's own page renders instead.
    await expect(
      page.getByRole('button', { name: /^(查看|View) dsh-arbiter$/u }),
    ).toHaveCount(0);
    await expect(page.locator('[data-arbiter-root]')).toHaveCount(0);

    // The session can still be reopened and used: removing the plugin returns
    // the conversation to the host's own controls rather than breaking it.
    await page
      .getByRole('treeitem', { name: /UNINSTALL-WARM/u })
      .first()
      .click();
    await expect(
      page.locator('[data-slot="conversation.input.permission"]'),
    ).toBeVisible();
    await expect(
      page.locator(
        '[data-slot="conversation.input.permission"] [data-arbiter-permission]',
      ),
    ).toHaveCount(0);
  } finally {
    await caseHost.dispose().catch(() => undefined);
  }
});
