/**
 * Real-host verification for standing execution guidance (#21).
 *
 * The evidence is the host's own session log, never the plugin's registration
 * object: the guidance has to appear in the `system/message` the host actually
 * composed for a managed main session and for a managed subagent, must be
 * absent for a session the plugin never took over, and must survive a real
 * compaction. The last case drives the three approval modes through the
 * host's own `ask_user_question` card, so "asking is still possible" and "an
 * answer is not an approval" are observed on the product path.
 */
import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession, type LoggedSession } from './dsh/session-log.js';

const FORMAT = 'arbiter-config-v2';

/** A distinctive fragment of each role's guidance, stable across rewording. */
const PARENT_MARKER = 'relay the answer to the subtask accurately';
const SUBAGENT_MARKER = 'report the pending operation';

interface ArbiterStateBody {
  readonly config?: Record<string, unknown>;
  readonly effectiveRevision?: string;
  /** The profile patch revision a save must carry to pass its guard. */
  readonly fileRevision?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function arbiterState(host: DshHost): Promise<ArbiterStateBody> {
  const response = await fetch(`${host.origin}/api/arbiter/state`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const root = recordOf(body);
  return {
    config: recordOf(root['config']),
    ...(typeof root['effectiveRevision'] === 'string'
      ? { effectiveRevision: root['effectiveRevision'] }
      : {}),
    fileRevision:
      typeof root['fileRevision'] === 'string' ? root['fileRevision'] : null,
  };
}

/** Save one configuration draft through the product's own endpoint. */
async function saveConfig(
  host: DshHost,
  change: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const state = await arbiterState(host);
  const config = change(state.config ?? {});
  const response = await fetch(`${host.origin}/api/arbiter/config/save`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    // The route's guard is the profile patch revision, not the effective
    // configuration revision; a mismatch is a conflict, so read it from state.
    body: JSON.stringify({ revision: state.fileRevision, config }),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  return recordOf(body);
}

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
  const body: unknown = await response.json();
  expect(body).toMatchObject({ admission: { enabled: true, managed: true } });
}

/** Every system prompt the host composed, oldest first, joined. */
function systemText(session: LoggedSession): string {
  return session.events
    .filter((event) => event.type === 'system/message')
    .map((event) => {
      const message = recordOf(recordOf(event.data)['message']);
      const content: unknown = message['content'];
      if (!Array.isArray(content)) return '';
      return content
        .map((block) => {
          const entry = recordOf(block);
          return typeof entry['text'] === 'string' ? entry['text'] : '';
        })
        .join('');
    })
    .join('\n');
}

/** Open the isolated host in the browser with its own bootstrap cookie. */
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

async function newSession(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: '新建会话', exact: true })
    .first()
    .click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/** Wait for a settled turn whose log already carries `marker`. */
async function turnWith(
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
  if (session === null) throw new Error(`no settled turn carried ${marker}`);
  return session;
}

/** Wait for the session object of one id to carry `predicate`. */
async function waitFor(
  host: DshHost,
  predicate: (session: LoggedSession) => boolean,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(host.home, predicate, timeoutMs);
  if (session === null)
    throw new Error('the expected session state never appeared');
  return session;
}

/** Every decision record the plugin committed for one session. */
function decisions(session: LoggedSession): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .map((event) => recordOf(event.data));
}

/** Every decision result the plugin recorded for one session. */
function decisionResults(session: LoggedSession): readonly string[] {
  return decisions(session).map((data) =>
    typeof data['result'] === 'string' ? data['result'] : '',
  );
}

/** The call id the host assigned to the session's `ask_user_question` call. */
function askCallIds(session: LoggedSession): readonly string[] {
  return session.events
    .filter((event) => event.type === 'tool/call')
    .map((event) => recordOf(event.data))
    .filter((data) => data['name'] === 'ask_user_question')
    .map((data) => (typeof data['callId'] === 'string' ? data['callId'] : ''))
    .filter((id) => id.length > 0);
}

test.describe('standing agent guidance', () => {
  test(
    'a managed main session carries the parent guidance and an unmanaged session carries none',
    { tag: '@smoke' },
    async ({ page }, testInfo) => {
      const caseHost: CaseHost = await createCaseHost(
        testInfo.outputPath('guidance-scope'),
        { arbiterRowConfig: { format: FORMAT, rules: [] } },
      );
      try {
        const host = caseHost.current();

        // An unenabled session: the plugin must contribute nothing at all.
        await openHost(page, host);
        await sendPrompt(page, 'GUIDE-PLAIN RUN echo guide-plain');
        const plain = await turnWith(host, 'GUIDE-PLAIN');
        expect(systemText(plain)).not.toContain(PARENT_MARKER);
        expect(systemText(plain)).not.toContain(SUBAGENT_MARKER);

        // Enabling the same session makes the next assembly carry it.
        await enableSession(host, plain.sessionId);
        await openHost(page, host);
        await sendPrompt(page, 'GUIDE-MANAGED RUN echo guide-managed');
        const managed = await waitFor(
          host,
          (candidate) =>
            candidate.sessionId === plain.sessionId &&
            candidate.events.some(
              (event) =>
                event.type === 'user/message' &&
                JSON.stringify(event.data).includes('GUIDE-MANAGED'),
            ) &&
            candidate.events.some((event) => event.type === 'turn/end'),
        );
        const managedSystem = systemText(managed);
        expect(managedSystem).toContain(PARENT_MARKER);
        // A main session never gets the subagent's reporting guidance.
        expect(managedSystem).not.toContain(SUBAGENT_MARKER);

        // A second session in the same host is still unmanaged: guidance is
        // per admission, not per installation.
        await openHost(page, host);
        await newSession(page);
        await sendPrompt(page, 'GUIDE-OTHER RUN echo guide-other');
        const other = await turnWith(host, 'GUIDE-OTHER');
        expect(other.sessionId).not.toBe(plain.sessionId);
        expect(systemText(other)).not.toContain(PARENT_MARKER);
        expect(systemText(other)).not.toContain(SUBAGENT_MARKER);
      } finally {
        await caseHost.dispose();
      }
    },
  );

  test('a managed subagent carries the reporting guidance', async ({
    page,
  }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('guidance-subagent'),
      { arbiterRowConfig: { format: FORMAT, rules: [] } },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-PARENT RUN echo guide-parent-warmup');
      const parent = await turnWith(host, 'GUIDE-PARENT');
      await enableSession(host, parent.sessionId);

      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-DELEGATE DELEGATE echo guide-child');
      const child = await waitFor(
        host,
        (candidate) =>
          candidate.header?.['parentSession'] === parent.sessionId &&
          candidate.events.some(
            (event) =>
              event.type === 'user/message' &&
              JSON.stringify(event.data).includes('guide-child'),
          ) &&
          candidate.events.some((event) => event.type === 'turn/end'),
      );
      const childSystem = systemText(child);
      expect(childSystem).toContain(SUBAGENT_MARKER);
      expect(childSystem).not.toContain(PARENT_MARKER);
    } finally {
      await caseHost.dispose();
    }
  });

  test('the guidance survives a real compaction', async ({
    page,
  }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('guidance-compact'),
      { arbiterRowConfig: { format: FORMAT, rules: [] } },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C1 RUN echo compact-one');
      const first = await turnWith(host, 'GUIDE-C1');
      await enableSession(host, first.sessionId);
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C2 RUN echo compact-two');
      await waitFor(
        host,
        (candidate) =>
          candidate.sessionId === first.sessionId &&
          candidate.events.some(
            (event) =>
              event.type === 'user/message' &&
              JSON.stringify(event.data).includes('GUIDE-C2'),
          ) &&
          candidate.events.some((event) => event.type === 'turn/end'),
      );

      // The host's own `/compact`: a real compaction transaction, not a
      // simulated replacement.
      await openHost(page, host);
      await sendPrompt(page, '/compact');
      const compacted = await waitFor(
        host,
        (candidate) =>
          candidate.sessionId === first.sessionId &&
          candidate.events.some((event) => event.type === 'compaction/end'),
      );
      const ended = compacted.events.filter(
        (event) => event.type === 'compaction/end',
      );
      expect(ended.length).toBeGreaterThan(0);
      // The compaction really replaced history: the plugin's own guidance is
      // still in the system prompt the host keeps for every later step.
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C3 RUN echo compact-three');
      const after = await waitFor(
        host,
        (candidate) =>
          candidate.sessionId === first.sessionId &&
          candidate.events.some(
            (event) =>
              event.type === 'user/message' &&
              JSON.stringify(event.data).includes('GUIDE-C3'),
          ) &&
          candidate.events.some((event) => event.type === 'turn/end'),
      );
      expect(systemText(after)).toContain(PARENT_MARKER);
    } finally {
      await caseHost.dispose();
    }
  });

  test('all three approval modes still let the agent ask and never record the answer as human-allow', async ({
    page,
  }, testInfo) => {
    const caseHost: CaseHost = await createCaseHost(
      testInfo.outputPath('guidance-ask'),
      { arbiterRowConfig: { format: FORMAT, rules: [] } },
    );
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-ASK-WARMUP RUN echo ask-warmup');
      const session = await turnWith(host, 'GUIDE-ASK-WARMUP');
      await enableSession(host, session.sessionId);

      for (const mode of ['normal', 'strict', 'progress'] as const) {
        await saveConfig(host, (config) => ({
          ...config,
          modes: { main: mode, subagent: 'strict' },
        }));
        await openHost(page, host);
        const marker = `GUIDE-ASK-${mode.toUpperCase()}`;
        await sendPrompt(
          page,
          `${marker} ASK 是否允许执行 /workspace/app/build 的清理？`,
        );

        // The host's own question card appears: the plugin neither answered it
        // nor suppressed it in any mode.
        const card = page.getByRole('radiogroup').first();
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(
          page
            .getByText('/workspace/app/build 的清理', { exact: false })
            .first(),
        ).toBeVisible();
        await card.getByRole('radio', { name: '允许', exact: true }).click();
        await page.getByRole('button', { name: '提交', exact: true }).click();

        const answered = await waitFor(
          host,
          (candidate) =>
            candidate.sessionId === session.sessionId &&
            candidate.events.some(
              (event) =>
                event.type === 'user/message' &&
                JSON.stringify(event.data).includes(marker),
            ) &&
            candidate.events.some(
              (event) =>
                event.type === 'tool/result' &&
                JSON.stringify(event.data).includes('authorization'),
            ),
        );
        const results = decisionResults(answered);
        // Whatever the review decided about the ask call, an answer is never an
        // approval: no recorded decision may claim human-allow.
        expect(results).not.toContain('human-allow');
        // The ask call itself was admitted in this mode rather than refused, so
        // the mode never forbids asking. (The plugin does not special-case the
        // tool; this asserts the outcome, not an exemption.)
        const asked = askCallIds(answered);
        expect(asked.length).toBeGreaterThan(0);
        const askDecisions = decisions(answered).filter((data) =>
          asked.includes(String(data['callId'])),
        );
        expect(askDecisions.length).toBeGreaterThan(0);
        for (const decision of askDecisions) {
          expect([
            'allow',
            'review-allow',
            'human-allow',
            'force-ask',
            'review-escalate',
          ]).toContain(decision['result']);
          expect(decision['result']).not.toBe('human-allow');
        }
        // And the answer reached the model as the host's own tool result, so
        // the ask call itself was not refused in this mode.
        expect(
          answered.events.some(
            (event) =>
              event.type === 'tool/result' &&
              JSON.stringify(event.data).includes('authorization') &&
              JSON.stringify(event.data).includes('允许'),
          ),
        ).toBe(true);
      }
    } finally {
      await caseHost.dispose();
    }
  });
});
