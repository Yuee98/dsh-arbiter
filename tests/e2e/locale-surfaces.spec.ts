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
import zhDenials from '../../locale/zh/denials.json' with { type: 'json' };
import enDenials from '../../locale/en/denials.json' with { type: 'json' };

const FORMAT = 'arbiter-config-v2';

/** A declared route with no server behind it: the probe fails, fast and free. */
const MODEL_GROUPS = [
  {
    provider: 'locale-probe',
    displayName: 'Locale probe',
    models: [{ id: 'locale-probe-model', name: 'Locale Probe Model' }],
  },
] as const;

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

/**
 * The persisted raw payloads a call detail renders, without their labels.
 *
 * Only the `<pre>` blocks are returned: they hold the stored JSON exactly as it
 * was written. The surrounding labels are UI copy and legitimately translate, so
 * including them would make a "nothing changed" comparison meaningless. Each
 * material group is collapsed by default, so the helper expands them the way a
 * reader would.
 */
async function rawDetailText(page: Page): Promise<readonly string[]> {
  const root = page.locator('[data-arbiter-root]');
  const raw = root.locator('[data-call-detail-raw]');
  await expect(raw).toBeVisible();
  // Every disclosure in this panel is a `<button aria-expanded>`; open the
  // collapsed ones in reading order so the payload blocks are in the DOM.
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const collapsed = raw.locator('button[aria-expanded="false"]');
    if ((await collapsed.count()) === 0) break;
    await collapsed
      .first()
      .click()
      .catch(() => undefined);
  }
  const blocks = page.locator('[data-call-detail-raw] pre');
  await expect(blocks.first()).toBeVisible();
  return (await blocks.allInnerTexts()).map((text) => text.trim());
}

/**
 * The recorded verdict reason a detail shows, without its translated labels.
 *
 * The reason is the last child of the verdict section: the first row holds the
 * translated heading and the verdict word, so slicing by line count is wrong —
 * a two-line region yields `''`, and comparing two empty strings would pass
 * without asserting anything. The section carries a stable data attribute, so
 * the reason is located structurally. A blank result throws instead of
 * travelling on as a vacuous comparison.
 */
async function verdictText(page: Page, regionName: string): Promise<string> {
  const region = page.locator('[data-call-detail-verdict]').filter({
    has: page.getByRole('region', { name: regionName, exact: true }),
  });
  const target =
    (await region.count()) > 0
      ? region.first()
      : page.getByRole('region', { name: regionName, exact: true });
  await expect(target).toBeVisible();
  const reason = target.locator('div').last();
  const text = (await reason.innerText()).trim();
  // A blank reason cannot carry an assertion: every comparison below would be
  // vacuously true. Fail loudly instead of passing on empty strings.
  expect(
    text.length,
    'the recorded verdict reason is empty; the comparison would be vacuous',
  ).toBeGreaterThan(0);
  return text;
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
      // A real catalog entry for the Reviewer picker. The route points at a
      // closed local port, so the probe fails fast: this case asserts the
      // dialog's English state, not a model reply, and needs no credential.
      modelGroups: MODEL_GROUPS,
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
    // The saved value is what a language switch must preserve. A host language
    // change reloads the client, so an unsaved draft is not expected to survive
    // it and this case does not claim that; see the comment at the assertion.
    await expect(
      ruleRow.getByRole('textbox', { name: zhRules.name, exact: true }),
    ).toHaveValue(LONG_RULE.name);
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

    // ---- AC6 baseline: captured in Chinese, BEFORE the first switch ------
    // Comparing two English-side readings would miss a rewrite that happened
    // on the way into English: both sides would already hold the damaged
    // value. The comparison therefore starts from the Chinese original.
    await plugin
      .getByRole('button', { name: zhPage.logs, exact: true })
      .click();
    await expect(
      plugin.getByRole('heading', { name: zhLogs.title, exact: true }),
    ).toBeVisible();
    const zhLogRow = plugin
      .getByRole('list', { name: zhLogs.title, exact: true })
      .getByRole('button')
      .first();
    await expect(zhLogRow).toBeVisible();
    await zhLogRow.click();
    const baselineRaw = await rawDetailText(page);
    const baselineVerdict = await verdictText(page, zhCallDetail.finalVerdict);
    expect(baselineRaw.length).toBeGreaterThan(0);
    expect(baselineRaw.join('\n')).toContain('locale-denied-one');
    // Return to the configuration frame; the journey continues from there.
    await openConfiguration(page);

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
    // The saved user content survives the language switch verbatim: only the
    // chrome is translated, never the user's own text. (A host language change
    // reloads the client, so unsaved drafts are out of scope here.)
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

    // The Reviewer surface: following the session disables the entry and says
    // so; choosing a concrete route enables it and the real dialog opens, runs
    // against the seeded local provider and renders its material in English.
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
    await expect(openTest).toBeDisabled();
    await expect(
      english.getByText(enReviewer.test.sessionDisabled, { exact: true }),
    ).toBeVisible();

    // A concrete model route enables the entry. The seeded provider points at a
    // closed local port, so the probe fails fast without a credential or a paid
    // request — the point is the real route, the real dialog and its English
    // material, not a successful model reply.
    await english
      .getByRole('combobox', { name: enReviewer.model.label, exact: true })
      .selectOption({
        label: 'Locale probe / locale-probe-model（Locale Probe Model）',
      });
    await expect(openTest).toBeEnabled();
    await expect(
      english.getByText(enReviewer.test.costNotice, { exact: true }),
    ).toBeVisible();
    const [probeResponse] = await Promise.all([
      page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/arbiter/reviewer-test',
      ),
      openTest.click(),
    ]);
    expect(probeResponse.status()).toBe(200);
    const dialog = english.getByRole('dialog', {
      name: enReviewer.test.title,
      exact: true,
    });
    await expect(dialog).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: enReviewer.test.close, exact: true }),
    ).toBeVisible();
    // The run started on open, so the terminal state is English, not a
    // placeholder and not the source text.
    await expect(dialog.locator('[data-arbiter-probe-status]')).toBeVisible();
    await expect(
      dialog.locator('[data-arbiter-probe-status="failed"]'),
    ).toBeVisible();
    expect(await dialog.innerText()).not.toMatch(/[\u4e00-\u9fff]/u);
    expect(await dialog.innerText()).not.toMatch(
      /reviewer\.|\{\w+\}|undefined/u,
    );
    // The seeded route declares no credential, and the OpenAI-compatible
    // protocol refuses to dispatch without one, so the classified stage is the
    // credential. Asserting the stable code ties this to the stage; asserting
    // the sentence proves the classification is rendered in English.
    await expect(
      dialog.locator('[data-arbiter-probe-failure="credential-missing"]'),
    ).toBeVisible();
    expect(await dialog.innerText()).toContain(
      enReviewer.test.failure.credentialMissing,
    );
    expect(
      await clippedText(page, '[aria-label="Reviewer connection test"]'),
    ).toEqual([]);
    // The failure material is expandable and stays inside the dialog.
    await dialog.getByText(enReviewer.test.details, { exact: true }).click();
    await expect(
      dialog.getByText(enReviewer.test.attempt.replace('{n}', '1'), {
        exact: false,
      }),
    ).toBeVisible();
    await dialog
      .getByRole('button', { name: enReviewer.test.close, exact: true })
      .click();
    await expect(dialog).toBeHidden();
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
    // ---- AC6: the English read still matches the Chinese baseline --------
    // The values below were captured before the first switch, so a rewrite on
    // the way into English would show up as a difference here.
    const rawInEnglish = await rawDetailText(page);
    const verdictInEnglish = await verdictText(page, enCallDetail.finalVerdict);
    expect(rawInEnglish).toEqual(baselineRaw);
    expect(verdictInEnglish).toEqual(baselineVerdict);

    // The coexistence alert needs a real conflicting provider, so its bilingual
    // rendering is asserted where that composition exists: `coexistence.spec.ts`
    // switches the host language with the official Auto Review actually running.

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
    // Back in Chinese, the same call's persisted material and recorded reason
    // must still equal the ORIGINAL Chinese baseline: zh → en → zh is a full
    // round trip, so comparing only against the English read would not prove
    // the original survived.
    expect(await rawDetailText(page)).toEqual(baselineRaw);
    expect(await verdictText(page, zhCallDetail.finalVerdict)).toEqual(
      baselineVerdict,
    );
    expectNoLeak(await page.locator('[data-arbiter-root]').innerText());
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
