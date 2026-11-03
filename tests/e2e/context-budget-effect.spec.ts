import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { estimateTokenCount } from 'tokenx';
import { isRecord } from '../../src/config/values.js';
import { createCaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession } from './dsh/session-log.js';
import {
  dismissGettingStarted,
  openArbiterConfiguration,
  startNewSession,
} from './dsh/ui.js';

const TARGET = '常态输入目标 T（估算 tokens）';
const HARD = '输入硬上限 H（估算 tokens）';
const retired = {
  evidenceMaxItems: 0,
  parentHumanItems: 0,
  historyMaxItems: 0,
};

async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  const preview = page.getByRole('dialog', { name: /预览版说明|Preview/i });
  if (await preview.isVisible())
    await preview.getByRole('button', { name: /^(继续|Continue)$/ }).click();
  await dismissGettingStarted(page, { optional: true });
}

async function state(page: Page, host: DshHost) {
  const response = await page.request.get(`${host.origin}/api/arbiter/state`);
  expect(response.status()).toBe(200);
  const body: unknown = await response.json();
  const config = isRecord(body) ? body['config'] : null;
  const context = isRecord(config) ? config['context'] : null;
  if (!isRecord(context)) throw new Error('missing effective context');
  return context;
}

async function openBudget(page: Page, host: DshHost): Promise<void> {
  await openHost(page, host);
  await openArbiterConfiguration(page);
  await page
    .locator('[data-arbiter-root]')
    .getByRole('button', { name: '策略与高级' })
    .click();
}

async function save(page: Page, target: number, hard: number): Promise<void> {
  const plugin = page.locator('[data-arbiter-root]');
  await plugin.getByRole('spinbutton', { name: TARGET }).fill(String(target));
  await plugin.getByRole('spinbutton', { name: HARD }).fill(String(hard));
  const [response] = await Promise.all([
    page.waitForResponse(
      (entry) =>
        new URL(entry.url()).pathname === '/api/arbiter/config/save' &&
        entry.request().method() === 'POST',
    ),
    plugin.getByRole('button', { name: '保存并应用' }).click(),
  ]);
  expect(response.status()).toBe(200);
  await expect(plugin.locator('[data-arbiter-save-status="saved"]')).toHaveText(
    '已保存并生效。',
  );
}

async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.fill(text);
  await composer.press('Enter');
}

async function settled(
  host: DshHost,
  id: string,
  turns: number,
): Promise<void> {
  const result = await waitForSession(
    host.home,
    (candidate) =>
      candidate.sessionId === id &&
      candidate.events.filter((event) => event.type === 'turn/end').length >=
        turns,
  );
  if (result === null)
    throw new Error(`budget session ${id} never settled turn ${String(turns)}`);
}

/** Identical seed and pending action in separate real sessions isolate T. */
async function probe(page: Page, host: DshHost): Promise<void> {
  const id = await startNewSession(page);
  await send(
    page,
    'BUDGET-SEED RUN python3 -c "print(\'BUDGET_HISTORY_\' * 1000)"',
  );
  await settled(host, id, 1);
  const admitted = await page.request.post(
    `${host.origin}/api/arbiter/sessions`,
    { data: { sessionId: id, action: 'enable' } },
  );
  expect(admitted.status()).toBe(200);
  await send(page, 'BUDGET-PROBE RUN echo budget-probe');
  await settled(host, id, 2);
}

async function requests(directory: string) {
  const files = await readdir(directory);
  const captured: {
    readonly system: string;
    readonly user: string;
    readonly tokens: number;
  }[] = [];
  for (const file of files.sort()) {
    const raw: unknown = JSON.parse(
      await readFile(join(directory, file), 'utf8'),
    );
    if (
      !isRecord(raw) ||
      typeof raw['system'] !== 'string' ||
      !Array.isArray(raw['messages'])
    )
      throw new Error('invalid captured reviewer wire');
    const texts: string[] = [];
    for (const message of raw['messages']) {
      if (!isRecord(message) || !Array.isArray(message['content']))
        throw new Error('invalid captured message');
      for (const block of message['content']) {
        if (!isRecord(block) || typeof block['text'] !== 'string')
          throw new Error('invalid captured text');
        texts.push(block['text']);
      }
    }
    captured.push({
      system: raw['system'],
      user: texts.join('\n'),
      tokens:
        estimateTokenCount(raw['system']) +
        texts.reduce((sum, text) => sum + estimateTokenCount(text), 0),
    });
  }
  return captured;
}

test(
  'legacy explicit H is preserved through settings save and cold restart',
  { tag: '@smoke' },
  async ({ page }, info) => {
    const caseHost = await createCaseHost(info.outputPath('legacy-budget'), {
      arbiterRowConfig: { context: { maxInputTokens: 4000, ...retired } },
    });
    try {
      const host = caseHost.current();
      await openHost(page, host);
      // Dismissing the host welcome notice asynchronously saves its own row.
      // Establish the profile baseline only after that independent write settles.
      await expect
        .poll(async () =>
          (await readFile(host.documentPath, 'utf8')).includes(
            'welcomeNoticeVersion',
          ),
        )
        .toBe(true);
      const original = await readFile(host.documentPath, 'utf8');
      await openArbiterConfiguration(page);
      await page
        .locator('[data-arbiter-root]')
        .getByRole('button', { name: '策略与高级' })
        .click();
      await expect(page.getByRole('spinbutton', { name: TARGET })).toHaveValue(
        '4000',
      );
      await expect(page.getByRole('spinbutton', { name: HARD })).toHaveValue(
        '4000',
      );
      expect(await readFile(host.documentPath, 'utf8')).toBe(original);
      await save(page, 3500, 4000);
      const saved = await readFile(host.documentPath, 'utf8');
      const restarted = await caseHost.restart();
      await openBudget(page, restarted);
      expect(await state(page, restarted)).toMatchObject({
        targetInputTokens: 3500,
        maxInputTokens: 4000,
      });
      expect(await readFile(restarted.documentPath, 'utf8')).toBe(saved);
      await expect(page.getByRole('spinbutton', { name: TARGET })).toHaveValue(
        '3500',
      );
      await expect(page.getByRole('spinbutton', { name: HARD })).toHaveValue(
        '4000',
      );
    } finally {
      await caseHost.dispose();
    }
  },
);

test(
  'UI-saved T changes actual Reviewer history under fixed H after cold restart',
  { tag: '@smoke' },
  async ({ page }, info) => {
    const directory = info.outputPath('review-wire');
    const caseHost = await createCaseHost(info.outputPath('budget-effect'), {
      arbiterRowConfig: {
        modes: { main: 'no-ask', subagent: 'no-ask' },
        reviewer: {
          chat: {
            provider: 'arbiter-budget-reviewer',
            model: 'budget-reviewer',
          },
        },
        context: { ...retired },
      },
      extraRows: [
        {
          insert: [
            {
              id: 'budget-reviewer',
              name:
                'file://' +
                fileURLToPath(
                  new URL('./dsh/budget-reviewer/index.ts', import.meta.url),
                ),
              config: { directory },
            },
          ],
        },
      ],
    });
    const configPage = await page.context().newPage();
    try {
      await openBudget(configPage, caseHost.current());
      await save(configPage, 3500, 10000);
      const host = await caseHost.restart();
      await openHost(page, host);
      await probe(page, host);
      const low = await requests(directory);
      expect(low).toHaveLength(1);
      await openBudget(configPage, host);
      await save(configPage, 7000, 10000);
      await probe(page, host);
      const all = await requests(directory);
      expect(all).toHaveLength(2);
      const first = all[0];
      const second = all[1];
      if (first === undefined || second === undefined)
        throw new Error('missing budget contrast');
      expect(first.system).toBe(second.system);
      expect(first.user).toContain('budget-probe');
      expect(second.user).toContain('budget-probe');
      const historySize = (text: string) =>
        (text.match(/BUDGET_HISTORY_/gu) ?? []).length;
      expect(historySize(first.user)).toBeGreaterThan(0);
      expect(historySize(second.user)).toBeGreaterThan(
        historySize(first.user) + 10,
      );
      expect(first.tokens).toBeLessThanOrEqual(3500);
      expect(second.tokens).toBeLessThanOrEqual(7000);
      expect(second.tokens).toBeGreaterThan(first.tokens);
      expect(await state(configPage, host)).toMatchObject({
        targetInputTokens: 7000,
        maxInputTokens: 10000,
      });
      await writeFile(
        info.outputPath('budget-proof.json'),
        JSON.stringify(
          {
            source:
              'actual reviewer adapter requests; no provider usage assertion',
            fixedH: 10000,
            low: {
              target: 3500,
              tokens: first.tokens,
              historyMarkers: historySize(first.user),
            },
            high: {
              target: 7000,
              tokens: second.tokens,
              historyMarkers: historySize(second.user),
            },
          },
          null,
          2,
        ),
      );
    } finally {
      await configPage.close();
      await caseHost.dispose();
    }
  },
);
