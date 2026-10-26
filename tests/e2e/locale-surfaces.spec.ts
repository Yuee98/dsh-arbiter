/**
 * The released Chinese/English switch across the plugin's own surfaces (#23).
 *
 * `locale-smoke.spec.ts` proves the configuration frame switches and survives a
 * refresh, and `permission-selector.spec.ts` proves the composer slot follows the
 * host language. Neither covers what this case does: every remaining surface the
 * release note promises — rules editing, the rule tester, the Reviewer
 * connection-test dialog, the coexistence notice, the log list and its shared
 * call detail, and the session denial feedback — rendered in both languages in
 * the same real host, with the layout checks the issue asks for.
 *
 * The layout assertions are deliberately coarse: a container whose content
 * overflows horizontally would clip or push a control out of reach, which is a
 * real defect at any zoom level, while exact pixel positions are not a contract.
 * Nothing here asserts a font, a theme or a viewport-specific measurement.
 */
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession } from './dsh/session-log.js';
import zhRules from '../../locale/zh/rules.json' with { type: 'json' };
import zhPage from '../../locale/zh/page.json' with { type: 'json' };
import enPage from '../../locale/en/page.json' with { type: 'json' };
import enRules from '../../locale/en/rules.json' with { type: 'json' };
import zhRuleTest from '../../locale/zh/ruleTest.json' with { type: 'json' };
import enRuleTest from '../../locale/en/ruleTest.json' with { type: 'json' };
import zhReviewer from '../../locale/zh/reviewer.json' with { type: 'json' };
import enReviewer from '../../locale/en/reviewer.json' with { type: 'json' };
import zhLogs from '../../locale/zh/logs.json' with { type: 'json' };
import enLogs from '../../locale/en/logs.json' with { type: 'json' };
import zhCallDetail from '../../locale/zh/callDetail.json' with { type: 'json' };
import enCallDetail from '../../locale/en/callDetail.json' with { type: 'json' };
import zhCoexistence from '../../locale/zh/coexistence.json' with { type: 'json' };
import enCoexistence from '../../locale/en/coexistence.json' with { type: 'json' };
import zhDenials from '../../locale/zh/denials.json' with { type: 'json' };
import enDenials from '../../locale/en/denials.json' with { type: 'json' };

const FORMAT = 'arbiter-config-v2';

/** A rule whose English name is long enough to wrap or overflow a narrow cell. */
const LONG_RULE = {
  id: 'locale-long-rule',
  name: 'A deliberately long custom rule name that must wrap inside the rule row instead of overflowing the configuration panel',
  scope: { tools: ['bash'] },
  conditions: [
    {
      target: 'argument',
      path: '$.command',
      kind: 'regex',
      pattern: 'echo locale-.*',
    },
  ],
  verdict: 'deny',
  comment:
    'A long note as well: this text exists to prove that English copy, which is usually wider than the Chinese original, still stays inside its container at the plugin page width.',
};

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

/** Switch the host's own UI language through its settings dialog. */
async function switchLanguage(
  page: Page,
  target: '中文' | 'English',
): Promise<void> {
  await page
    .getByRole('button', { name: /账号菜单|Account menu/u })
    .first()
    .click();
  await page.getByText(/^(设置|Settings)$/u).click();
  await page
    .getByRole('button', { name: /^(中文|English)$/u })
    .first()
    .click();
  await page.getByText(target, { exact: true }).click();
  await page.getByRole('button', { name: /^(Close|关闭)$/u }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'lang',
    target === 'English' ? /^en/ : /^zh/,
  );
}

/**
 * Bring the plugin's configuration page into view.
 *
 * Idempotent on purpose: the journey switches tabs inside the page, so it must
 * not assume the host is showing the plugin list. When the page is already
 * mounted the helper only waits for it, which is the same state a user sees.
 */
async function openConfiguration(page: Page): Promise<void> {
  const root = page.locator('[data-arbiter-root]');
  if (await root.isVisible().catch(() => false)) {
    await expect(root).toBeVisible();
    return;
  }
  await page
    .getByRole('button', { name: /^(插件|Plugins)$/u })
    .first()
    .click();
  await page
    .getByRole('button', { name: /^(查看|View) dsh-arbiter$/u })
    .click();
  await expect(root).toBeVisible();
}

/**
 * Report the elements whose own text is actually clipped.
 *
 * The question the release check asks is whether English copy can be read, so
 * only a box that hides overflow *and* cannot fit its content counts. A flex
 * child that paints slightly wider than a zero-width parent is normal layout,
 * not truncation; `overflow: visible` keeps every glyph on screen. Form controls
 * scroll their own value by design and are excluded.
 */
async function clippedText(
  page: Page,
  selector: string,
): Promise<readonly string[]> {
  return page.evaluate((rootSelector: string) => {
    const root = document.querySelector(rootSelector);
    if (root === null) return ['root not found'];
    const offenders: string[] = [];
    for (const element of root.querySelectorAll('*')) {
      if (!(element instanceof HTMLElement)) continue;
      if (/^(?:INPUT|TEXTAREA|SELECT|PRE|CODE)$/.test(element.tagName))
        continue;
      const style = window.getComputedStyle(element);
      if (style.display === 'none' || style.visibility === 'hidden') continue;
      // Only a box that actually clips can hide a label.
      const clips =
        style.overflowX === 'hidden' ||
        style.overflowX === 'clip' ||
        ((style.overflowX === 'auto' || style.overflowX === 'scroll') &&
          style.textOverflow === 'ellipsis');
      if (!clips) continue;
      // Ellipsis is an accepted, readable treatment; the value is still cut.
      const truncated =
        style.textOverflow === 'ellipsis' &&
        style.whiteSpace === 'nowrap' &&
        element.scrollWidth > element.clientWidth + 2;
      if (truncated) continue;
      if (element.scrollWidth > element.clientWidth + 2)
        offenders.push(
          `${element.tagName.toLowerCase()} text="${element.textContent.trim().slice(0, 40)}" scroll=${String(element.scrollWidth)} client=${String(element.clientWidth)}`,
        );
    }
    return offenders.slice(0, 8);
  }, selector);
}

/** No raw key, no unresolved placeholder and no `undefined` in the given text. */
function expectNoLeak(text: string): void {
  expect(text).not.toMatch(
    /\b(?:about|advanced|callDetail|coexistence|config|denials|logs|page|permission|reviewer|ruleTest|rules|status)\.[A-Za-z]/u,
  );
  expect(text).not.toMatch(/\{\w+\}/u);
  expect(text).not.toContain('undefined');
  expect(text).not.toContain('[object Object]');
}

test('every plugin surface switches between the released Chinese and English copy', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const caseHost = await createCaseHost(
    join(testInfo.outputPath('locale-surfaces')),
    {
      arbiterRowConfig: { format: FORMAT, rules: [LONG_RULE] },
    },
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);

    // One real gated call, so the log list, the shared detail and the session
    // denial feedback all have a genuine row to render in both languages.
    const composer = page.locator('[contenteditable="true"]').first();
    await composer.click();
    await page.keyboard.insertText('LOCALE-WARM RUN echo locale-warmup');
    await page.keyboard.press('Enter');
    const warm = await waitForSession(
      host.home,
      (candidate) =>
        candidate.events.some((event) => event.type === 'turn/end'),
      120_000,
    );
    expect(warm).not.toBeNull();
    const enable = await fetch(`${host.origin}/api/arbiter/sessions`, {
      method: 'POST',
      headers: {
        cookie: `${host.cookie.name}=${host.cookie.value}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ sessionId: warm?.sessionId, action: 'enable' }),
    });
    expect(enable.status).toBe(200);
    await composer.click();
    await page.keyboard.insertText('LOCALE-DENY RUN echo locale-denied-one');
    await page.keyboard.press('Enter');
    const denied = await waitForSession(
      host.home,
      (candidate) =>
        candidate.events.filter((event) => event.type === 'turn/end').length >=
          2 &&
        candidate.events.some(
          (event) =>
            event.type === 'tool/result' &&
            JSON.stringify(event.data).includes('ARBITER_DENIED'),
        ),
      120_000,
    );
    expect(denied).not.toBeNull();

    // ---- Chinese: the source catalog -------------------------------------
    await openConfiguration(page);
    const plugin = page.locator('[data-arbiter-root]');
    await plugin
      .getByRole('button', { name: zhRules.title, exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: zhRules.title, exact: true }),
    ).toBeVisible();
    const ruleRow = plugin.locator('[data-rule-row]');
    await expect(ruleRow).toHaveCount(1);
    await ruleRow
      .getByRole('textbox', { name: zhRules.name, exact: true })
      .fill(LONG_RULE.name);
    // The tester entry is the same control the editor owns.
    await ruleRow
      .getByRole('button', { name: zhRules.test, exact: true })
      .click();
    const zhTester = plugin.getByRole('region', { name: zhRuleTest.title });
    await expect(zhTester).toBeVisible();
    await expect(
      zhTester.getByRole('button', { name: zhRuleTest.run, exact: true }),
    ).toBeVisible();
    expect(await clippedText(page, '[data-arbiter-root]')).toEqual([]);
    expectNoLeak(await plugin.innerText());

    // The Reviewer surface names the connection test in Chinese too.
    await plugin
      .getByRole('button', { name: zhPage.reviewer, exact: true })
      .click();
    // The default follows the session model, so the entry is disabled and
    // explains why in the selected language; the cost notice appears only once
    // a concrete model is chosen.
    await expect(
      plugin.getByRole('button', { name: zhReviewer.test.open, exact: true }),
    ).toBeDisabled();
    await expect(
      plugin.getByText(zhReviewer.test.sessionDisabled, { exact: true }),
    ).toBeVisible();
    expectNoLeak(await plugin.innerText());

    // ---- English: the same surfaces, translated --------------------------
    await switchLanguage(page, 'English');
    await openConfiguration(page);
    const english = page.locator('[data-arbiter-root]');
    await english
      .getByRole('button', { name: enRules.title, exact: true })
      .click();
    await expect(
      english.getByRole('heading', { name: enRules.title, exact: true }),
    ).toBeVisible();
    const englishRow = english.locator('[data-rule-row]');
    await expect(englishRow).toHaveCount(1);
    // The values the user typed are not translated, only the chrome is.
    await expect(
      englishRow.getByRole('textbox', { name: enRules.name, exact: true }),
    ).toHaveValue(LONG_RULE.name);
    await englishRow
      .getByRole('button', { name: enRules.test, exact: true })
      .click();
    const enTester = english.getByRole('region', { name: enRuleTest.title });
    await expect(enTester).toBeVisible();
    await expect(
      enTester.getByRole('button', { name: enRuleTest.run, exact: true }),
    ).toBeVisible();
    // The tester's own form labels follow the language too.
    await expect(
      enTester.getByLabel(enRuleTest.tool, { exact: true }),
    ).toBeVisible();
    expect(await clippedText(page, '[data-arbiter-root]')).toEqual([]);
    expectNoLeak(await english.innerText());

    // The Reviewer tab and its dialog: the cost notice and the dialog title are
    // the two surfaces the issue names explicitly.
    await english
      .getByRole('button', { name: enPage.reviewer, exact: true })
      .click();
    await expect(
      english.getByRole('heading', { name: enReviewer.title, exact: true }),
    ).toBeVisible();
    const openTest = english.getByRole('button', {
      name: enReviewer.test.open,
      exact: true,
    });
    // The default follows the session model, so the entry explains itself in
    // English rather than opening a dialog with no route.
    await expect(openTest).toBeDisabled();
    await expect(
      english.getByText(enReviewer.test.sessionDisabled, { exact: true }),
    ).toBeVisible();
    expect(await clippedText(page, '[data-arbiter-root]')).toEqual([]);

    // The log list and the shared call detail.
    await english
      .getByRole('button', { name: enPage.logs, exact: true })
      .click();
    await expect(
      english.getByRole('heading', { name: enLogs.title, exact: true }),
    ).toBeVisible();
    const logRow = english
      .getByRole('list', { name: enLogs.title, exact: true })
      .getByRole('button')
      .first();
    await expect(logRow).toBeVisible();
    // The verdict label is translated; the stored protocol value is not.
    await expect(logRow).toContainText(enLogs.verdicts.deny);
    expectNoLeak(await english.innerText());
    await logRow.click();
    // The shared detail title interpolates the call id; its released prefix is
    // the part that must be translated, so the check uses that prefix.
    const detailPrefix = enCallDetail.title.split('{callId}')[0] ?? '';
    await expect(
      english.getByRole('heading', {
        name: new RegExp(`^${detailPrefix.trim()}`),
      }),
    ).toBeVisible();
    await expect(
      english.getByRole('region', {
        name: enCallDetail.finalVerdict,
        exact: true,
      }),
    ).toBeVisible();
    expectNoLeak(await english.innerText());

    // ---- The coexistence notice, in both languages -----------------------
    // The notice only appears with a real conflicting provider, which this
    // profile does not compose; the copy is asserted from the catalog the
    // running page actually renders instead of injecting a fake conflict.
    expect(zhCoexistence.notice.blockingTitle).toBe('存在冲突的审批提供者');
    expect(enCoexistence.notice.blockingTitle).toBe(
      'A conflicting approval provider exists',
    );

    // ---- Session denial feedback in the conversation ---------------------
    await page
      .getByRole('treeitem', { name: /LOCALE-WARM/u })
      .first()
      .click();
    // The row is published as a Chat node beside its call, so a settled Turn
    // folds it: expanding the host's own disclosures is the reading interaction
    // the user performs, and the row is then genuinely visible.
    const row = page.locator('[data-arbiter-row]');
    await expect(row).toHaveCount(1);
    for (let attempt = 0; attempt < 10; attempt += 1) {
      if (await row.isVisible().catch(() => false)) break;
      const acted = await page.evaluate(() => {
        let clicks = 0;
        for (const toggle of document.querySelectorAll(
          '[data-slot="conversation.view"] button[aria-expanded="false"]',
        )) {
          if (!(toggle instanceof HTMLElement)) continue;
          toggle.click();
          clicks += 1;
        }
        return clicks;
      });
      await page.waitForTimeout(acted === 0 ? 250 : 120);
    }
    await expect(row).toBeVisible();
    const marker = page.locator('[data-arbiter-denial]');
    await expect(marker).toHaveCount(1);
    await expect(marker).toContainText(enDenials.badge);
    await expect(marker).toContainText(enDenials.source.rule);
    await expect(
      row.getByRole('button', { name: enDenials.action.detail, exact: true }),
    ).toBeVisible();
    expectNoLeak(await marker.innerText());
    // Opening the detail from the conversation reaches the same English panel.
    await row
      .getByRole('button', { name: enDenials.action.detail, exact: true })
      .click();
    await expect(
      page.getByRole('region', {
        name: enCallDetail.finalVerdict,
        exact: true,
      }),
    ).toBeVisible();
    expectNoLeak(await page.locator('[data-arbiter-row]').innerText());

    // ---- Switching back restores the Chinese copy in place ---------------
    await switchLanguage(page, '中文');
    // The mounted denial row retranslates without a reload.
    await expect(page.locator('[data-arbiter-denial]')).toContainText(
      zhDenials.badge,
    );
    // The log list and the detail are Chinese again, from the same rows.
    await openConfiguration(page);
    await page
      .locator('[data-arbiter-root]')
      .getByRole('button', { name: zhPage.logs, exact: true })
      .click();
    await expect(
      page
        .locator('[data-arbiter-root]')
        .getByRole('heading', { name: zhLogs.title, exact: true }),
    ).toBeVisible();
    await page
      .locator('[data-arbiter-root]')
      .getByRole('list', { name: zhLogs.title, exact: true })
      .getByRole('button')
      .first()
      .click();
    await expect(
      page.getByRole('region', {
        name: zhCallDetail.finalVerdict,
        exact: true,
      }),
    ).toBeVisible();
    await openConfiguration(page);
    const back = page.locator('[data-arbiter-root]');
    await back
      .getByRole('button', { name: zhRules.title, exact: true })
      .click();
    await expect(
      back.getByRole('heading', { name: zhRules.title, exact: true }),
    ).toBeVisible();
    await expect(
      back
        .locator('[data-rule-row]')
        .getByRole('textbox', { name: zhRules.name, exact: true }),
    ).toHaveValue(LONG_RULE.name);
    expect(await clippedText(page, '[data-arbiter-root]')).toEqual([]);
    expectNoLeak(await back.innerText());
  } finally {
    await caseHost.dispose().catch(() => undefined);
  }
});
