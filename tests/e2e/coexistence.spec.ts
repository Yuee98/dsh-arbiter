/**
 * Real-host approval-provider coexistence (#6).
 *
 * Two cases run against the pinned DSH in an isolated home:
 *   1. the official Auto Review plugin is added to the profile composition and
 *      actually loads; a takeover must be refused with no admission record and
 *      no permission change, and removing the bundle must clear the block;
 *   2. another plugin that only declares approval capability must warn without
 *      blocking, keep Arbiter deciding, and leave its own guard denial outside
 *      Arbiter's verdict.
 *
 * The evidence is the host's own session log plus the plugin's HTTP surface, so
 * a saved configuration that never loaded can never pass for a running provider.
 */
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import { openArbiterConfiguration } from './dsh/ui.js';
import type { DshHost } from './dsh/host.js';
import {
  effectivePermission,
  permissionCommands,
  waitForSession,
  type LoggedSession,
} from './dsh/session-log.js';

const OFFICIAL = '@deepseek-ai/dsh-experimental-auto-review';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be an array`);
  return value;
}

/** The coexistence section of a raw state body. */
function coexistenceOf(body: unknown): Record<string, unknown> {
  return record(record(body, 'body')['coexistence'], 'coexistence');
}

async function getJson(
  host: DshHost,
  path: string,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${host.origin}${path}`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  const parsed: unknown = await response.json();
  return { status: response.status, body: parsed };
}

async function postJson(
  host: DshHost,
  path: string,
  body: unknown,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const response = await fetch(`${host.origin}${path}`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  return { status: response.status, body: parsed };
}

/** Send one line into the composer and wait for the session's settled turn. */
async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

async function sessionWithText(
  host: DshHost,
  text: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some((event) =>
        JSON.stringify(event.data).includes(text),
      ),
    timeoutMs,
  );
  if (session === null) throw new Error(`no session carried ${text}`);
  return session;
}

/** Poll the admission API until the session is live in this host. */
async function liveSession(
  host: DshHost,
  sessionId: string,
  timeoutMs = 30_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const view = await getJson(
      host,
      `/api/arbiter/sessions?sessionId=${encodeURIComponent(sessionId)}`,
    );
    if (view.status === 200) return;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`session ${sessionId} never became live`);
}

function decisions(session: LoggedSession): readonly string[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .map((event) => JSON.stringify(event.data));
}

function admissions(session: LoggedSession): readonly unknown[] {
  return session.events.filter(
    (event) => event.type === 'plugin:arbiter/admission',
  );
}

function toolCalls(session: LoggedSession): readonly string[] {
  return session.events
    .filter((event) => event.type === 'tool/call')
    .map((event) => JSON.stringify(event.data));
}

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

/** Run one fixture turn that issues exactly one real `bash` call. */
async function runOneCall(
  page: Page,
  host: DshHost,
  marker: string,
  command: string,
): Promise<LoggedSession> {
  await sendPrompt(page, `${marker} RUN ${command}`);
  const session = await sessionWithText(host, marker);
  await liveSession(host, session.sessionId);
  return session;
}

test.describe.configure({ mode: 'serial' });

test(
  'a running official Auto Review refuses a takeover and clearing it re-enables arbiter',
  { tag: '@smoke' },
  async ({ page }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('coexist-official'),
      {
        // The official plugin is a separate Loader row: adding the bundle here is
        // what makes it actually load in this isolated profile.
        extraRows: [
          {
            insert: [{ id: 'auto-review', name: OFFICIAL }],
          },
        ],
      },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);

      // The host reports the official plugin as actually running, and the
      // takeover surface reports a blocking conflict with its own guidance.
      const stateBefore = await getJson(host, '/api/arbiter/state');
      expect(stateBefore.status).toBe(200);
      const coexistence = coexistenceOf(stateBefore.body);
      expect(record(coexistence['official'], 'official')).toMatchObject({
        present: true,
        running: true,
      });
      expect(coexistence).toMatchObject({
        blocked: true,
        reason: 'official-running',
        detection: 'complete',
      });

      const session = await runOneCall(
        page,
        host,
        'COEXIST-BLOCKED',
        'echo coexist-blocked',
      );
      const sessionId = session.sessionId;
      // An unmanaged session is never gated, so no decision exists yet.
      expect(decisions(session)).toHaveLength(0);

      const refused = await postJson(host, '/api/arbiter/sessions', {
        sessionId,
        action: 'enable',
      });
      expect(refused.status).toBe(409);
      expect(record(refused.body, 'refusal')).toMatchObject({
        ok: false,
        code: 'coexistence-blocked',
      });
      expect(
        record(record(refused.body, 'refusal')['detail'], 'detail'),
      ).toMatchObject({
        reason: 'official-running',
        source: OFFICIAL,
        guidance: 'disable-official-auto-review',
      });

      // No takeover and therefore no permission expansion: the session log has
      // no admission record and no sandbox/approval write from this plugin.
      const afterRefusal =
        (await waitForSession(
          host.home,
          (item) => item.sessionId === sessionId,
        )) ?? session;
      expect(admissions(afterRefusal)).toHaveLength(0);
      const permission = effectivePermission(afterRefusal.events);
      expect(permission.sandbox).not.toBe('danger-full-access');

      // The page shows the reason and the way out, not just "failed".
      await openArbiterConfiguration(page);
      const alert = page.getByRole('alertdialog', {
        name: '存在冲突的审批提供者',
      });
      await expect(alert).toBeVisible();
      await expect(alert).toContainText(OFFICIAL);
      await expect(alert).toContainText('插件管理');

      // Turning the official plugin off is a real stop: a profile without the
      // bundle row must report no conflict and allow the takeover.
      const clearedCase: CaseHost = await createCaseHost(
        testInfo.outputPath('coexist-official-cleared'),
        {},
      );
      try {
        const clearedHost = clearedCase.current();
        await openHost(page, clearedHost);
        const cleared = coexistenceOf(
          (await getJson(clearedHost, '/api/arbiter/state')).body,
        );
        expect(record(cleared['official'], 'official')).toMatchObject({
          running: false,
        });
        expect(cleared).toMatchObject({ blocked: false, conflicts: [] });

        const fresh = await runOneCall(
          page,
          clearedHost,
          'COEXIST-CLEARED',
          'echo coexist-cleared',
        );
        const enabled = await postJson(clearedHost, '/api/arbiter/sessions', {
          sessionId: fresh.sessionId,
          action: 'enable',
        });
        expect(enabled.status).toBe(200);
        expect(record(enabled.body, 'enable')['admission']).toMatchObject({
          enabled: true,
          managed: true,
        });
      } finally {
        await clearedCase.dispose();
      }
    } finally {
      await caseHost.dispose().catch(() => undefined);
    }
  },
);

test('another approval listener warns without blocking and its guard stays separate', async ({
  page,
}, testInfo) => {
  const caseHost: CaseHost = await createCaseHost(
    testInfo.outputPath('coexist-third-party'),
    {
      arbiterRowConfig: {
        format: 'arbiter-config-v2',
        rules: [
          {
            id: 'allow-marker',
            scope: { tools: ['bash'] },
            conditions: [
              {
                target: 'argument',
                path: '$.command',
                kind: 'regex',
                pattern: 'echo coexist-.*',
              },
            ],
            verdict: 'allow',
          },
        ],
      },
      extraRows: [
        {
          insert: [
            {
              id: 'third-party-approval',
              name:
                'file://' +
                join(
                  testInfo.project.testDir,
                  'dsh',
                  'conflicting-provider',
                  'index.ts',
                ),
              config: { guardMarker: 'coexist-guard-deny' },
            },
          ],
        },
      ],
    },
  );
  try {
    const host = caseHost.current();
    await openHost(page, host);

    const coexistence = coexistenceOf(
      (await getJson(host, '/api/arbiter/state')).body,
    );
    // A warning, not a block: the session can still be taken over.
    expect(coexistence).toMatchObject({
      blocked: false,
      detection: 'complete',
    });
    const conflicts = list(coexistence['conflicts'], 'conflicts');
    expect(
      conflicts.some(
        (item) =>
          isRecord(item) &&
          item['kind'] === 'approval-hook' &&
          item['capability'] === 'tools/pre-execute',
      ),
    ).toBe(true);

    const session = await runOneCall(
      page,
      host,
      'COEXIST-WARN',
      'echo coexist-warn',
    );
    const enabled = await postJson(host, '/api/arbiter/sessions', {
      sessionId: session.sessionId,
      action: 'enable',
    });
    expect(enabled.status).toBe(200);

    // Arbiter keeps deciding: the allow rule records its own verdict.
    const allowed = await runOneCall(
      page,
      host,
      'COEXIST-ALLOW',
      'echo coexist-allow',
    );
    const allowedSession =
      (await waitForSession(host.home, (item) =>
        decisions(item).some((entry) => entry.includes('allow-marker')),
      )) ?? allowed;
    expect(
      decisions(allowedSession).some((entry) => entry.includes('allow')),
    ).toBe(true);

    // The other plugin's monotonic guard denies one command after Arbiter
    // allowed it. Arbiter must not claim that denial as its verdict.
    const guarded = await runOneCall(
      page,
      host,
      'COEXIST-GUARD',
      'echo coexist-guard-deny',
    );
    const guardedSession =
      (await waitForSession(host.home, (item) =>
        toolCalls(item).some((call) => call.includes('coexist-guard-deny')),
      )) ?? guarded;
    const records = decisions(guardedSession);
    expect(
      records.some(
        (entry) =>
          entry.includes('"result":"deny"') || entry.includes('error-escalate'),
      ),
    ).toBe(false);
    // The host's own guard refused the call after Arbiter allowed it: the
    // result is the guard's message, not an Arbiter denial.
    expect(
      guardedSession.events.some(
        (event) =>
          event.type === 'tool/result' &&
          JSON.stringify(event.data).includes('conflicting provider guard'),
      ),
    ).toBe(true);
    // No approval was opened and no mode was forced: the native permission
    // flow was never touched by detection.
    expect(permissionCommands(guardedSession.events)).toEqual([]);
    expect(effectivePermission(guardedSession.events).approval).toBe('ask');
  } finally {
    await caseHost.dispose();
  }
});
