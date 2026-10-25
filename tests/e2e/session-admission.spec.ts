/**
 * Real-host session admission and permission lifecycle (#4).
 *
 * Every case boots the pinned DSH on an isolated home with a deterministic
 * model fixture, so an agent turn issues one real `bash` call through the
 * whole host pipeline. The evidence is the host's own session log plus the
 * filesystem effect — never the plugin's memory or the audit database.
 *
 * The plugin's admission API is driven over HTTP, exactly as the session
 * permission selector (#5) will: this issue delivers the backend and proves it
 * through the public session surface.
 */
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import {
  effectivePermission,
  lastAdmission,
  permissionCommands,
  waitForSession,
  type LoggedSession,
} from './dsh/session-log.js';

interface ArbiterStateBody {
  readonly config?: { readonly boundary?: string };
  readonly effectiveRevision?: string;
  readonly admission?: unknown;
}

/** Read one JSON object answer without asserting its shape. */
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

/** One admission view from a raw body, or `null` when the answer has none. */
function admissionOf(body: unknown): Record<string, unknown> {
  const record = asRecord(body);
  if (record === null) return {};
  return asRecord(record['admission']) ?? {};
}

async function arbiterState(
  host: DshHost,
): Promise<{ readonly status: number; readonly body: ArbiterStateBody }> {
  const response = await fetch(`${host.origin}/api/arbiter/state`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  const body = await recordBody(response);
  const config = asRecord(body['config']);
  return {
    status: response.status,
    body: {
      ...(typeof config?.['boundary'] === 'string'
        ? { config: { boundary: config['boundary'] } }
        : {}),
      ...(typeof body['effectiveRevision'] === 'string'
        ? { effectiveRevision: body['effectiveRevision'] }
        : {}),
    },
  };
}

async function admissionRequest(
  host: DshHost,
  body: unknown,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const response = await fetch(`${host.origin}/api/arbiter/sessions`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const parsed: unknown = await response.json();
  return {
    status: response.status,
    body:
      parsed !== null && typeof parsed === 'object'
        ? { ...parsed }
        : { raw: String(parsed) },
  };
}

/** Wait for a session whose log already contains the requested user text. */
async function sessionWithText(
  host: DshHost,
  text: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some((event) => {
        const data: unknown = event.data;
        if (data === null || typeof data !== 'object') return false;
        return JSON.stringify(data).includes(text);
      }),
    timeoutMs,
  );
  if (session === null) throw new Error(`no session carried ${text}`);
  return session;
}

/** Wait until the log of `sessionId` shows a settled turn. */
async function settledTurn(
  host: DshHost,
  sessionId: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.events.some((event) => event.type === 'turn/end'),
    timeoutMs,
  );
  if (session === null) throw new Error(`session ${sessionId} never settled`);
  return session;
}

function toolCalls(session: LoggedSession): readonly string[] {
  return session.events
    .filter((event) => event.type === 'tool/call')
    .map((event) => {
      const data: unknown = event.data;
      if (data === null || typeof data !== 'object') return '';
      const args: unknown = Reflect.get(data, 'arguments');
      return typeof args === 'string' ? args : JSON.stringify(args);
    });
}

/** Tool call ids the session issued after its last `user/message` marker. */
function callsAfter(session: LoggedSession, marker: string): readonly string[] {
  let started = false;
  const ids: string[] = [];
  for (const event of session.events) {
    if (
      event.type === 'user/message' &&
      JSON.stringify(event.data).includes(marker)
    )
      started = true;
    if (!started || event.type !== 'tool/call') continue;
    const data: unknown = event.data;
    if (data === null || typeof data !== 'object') continue;
    const callId: unknown = Reflect.get(data, 'callId');
    if (typeof callId === 'string') ids.push(callId);
  }
  return ids;
}

/** Decisions Arbiter recorded for those exact calls. */
function decisionsFor(
  session: LoggedSession,
  callIds: readonly string[],
): readonly string[] {
  return decisionRecords(session).filter((entry) =>
    callIds.some((id) => entry.includes(`"callId":"${id}"`)),
  );
}

function decisionRecords(session: LoggedSession): readonly string[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .map((event) => {
      const data: unknown = event.data;
      if (data === null || typeof data !== 'object') return '';
      return JSON.stringify(data);
    });
}

/**
 * Open the isolated host in the browser with its own bootstrap cookie.
 *
 * A restart changes the port and the cookie, so every navigation re-registers
 * the cookie first; the page then behaves exactly like the product client.
 */
async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  const preview = page.getByRole('dialog', {
    name: /预览版说明|Preview/i,
  });
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

/** Start a new session through the host's own sidebar control. */
async function newSession(page: Page): Promise<void> {
  await page
    .getByRole('button', { name: '新建会话', exact: true })
    .first()
    .click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
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
  // The client resolves the session through its own stream before the session
  // is live on the host, so give it the same settle a human sees.
  await page.waitForTimeout(1500);
}

/** Poll the admission API until the session is live in this host. */
async function liveAdmission(
  host: DshHost,
  sessionId: string,
  timeoutMs = 30_000,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const deadline = Date.now() + timeoutMs;
  let latest = { status: 0, body: {} as Record<string, unknown> };
  while (Date.now() < deadline) {
    const response = await fetch(
      `${host.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(sessionId)}`,
      { headers: { cookie: `${host.cookie.name}=${host.cookie.value}` } },
    );
    latest = { status: response.status, body: await recordBody(response) };
    if (latest.status === 200) return latest;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return latest;
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
 * Send one user turn through the host's own prompt surface and wait for the
 * resulting tool call. The model fixture turns `RUN <cmd>` into that call.
 */
async function runOneCall(
  page: Page,
  host: DshHost,
  marker: string,
  command: string,
): Promise<LoggedSession> {
  await openHost(page, host);
  await sendPrompt(page, `${marker} RUN ${command}`);
  const session = await sessionWithText(host, marker);
  return settledTurn(host, session.sessionId);
}

test.describe('session admission', () => {
  test(
    'an unenabled session takes zero gate; enabling gates it; the same-value native command exits',
    { tag: '@smoke' },
    async ({ page }, testInfo) => {
      const caseHost: CaseHost = await createCaseHost(
        testInfo.outputPath('dsh-case'),
        {
          arbiterRowConfig: {
            rules: [
              {
                id: 'deny-marker',
                match: {
                  node: 'command',
                  kind: 'regex',
                  pattern: '^echo arbiter-deny',
                },
                verdict: 'deny',
              },
            ],
          },
        },
      );
      try {
        const host = caseHost.current();
        // A fresh profile never takes over a session.
        const state = await arbiterState(host);
        expect(state.status).toBe(200);
        expect(state.body.config?.boundary).toBe('guarded');

        const first = await runOneCall(
          page,
          host,
          'ADM-UNMANAGED',
          'echo arbiter-deny-unmanaged',
        );
        // The deny rule covers this exact command; an unmanaged session must
        // still execute it and produce no decision record at all.
        expect(
          toolCalls(first).some((args) => args.includes('arbiter-deny')),
        ).toBe(true);
        expect(first.events.some((event) => event.type === 'tool/result')).toBe(
          true,
        );
        expect(decisionRecords(first)).toHaveLength(0);
        const unmanaged = await admissionRequest(host, {
          sessionId: first.sessionId,
          action: 'enable',
        });
        expect(unmanaged.status).toBe(200);
        expect(unmanaged.body['admission']).toMatchObject({
          enabled: true,
          managed: true,
          reason: 'session-enabled',
          boundary: 'guarded',
        });

        const second = await runOneCall(
          page,
          host,
          'ADM-MANAGED',
          'echo arbiter-deny-managed',
        );
        const secondSessionId = second.sessionId;
        const gated = await waitForSession(
          host.home,
          (candidate) =>
            candidate.sessionId === secondSessionId &&
            candidate.events.some(
              (event) => event.type === 'plugin:arbiter/decision',
            ),
        );
        expect(gated).not.toBeNull();
        expect(decisionRecords(second)[0]).toContain('deny-rule');
        expect(
          second.events.some(
            (event) =>
              event.type === 'tool/result' &&
              JSON.stringify(event.data).includes('Not executed'),
          ),
        ).toBe(true);

        // The native same-value command: guarded at workspace-write, so the
        // host writes no permission event and only the command pair proves it.
        await openHost(page, host);
        await sendPrompt(page, '/permission workspace-write');
        const afterExit = await waitForSession(
          host.home,
          (candidate) =>
            candidate.sessionId === secondSessionId &&
            candidate.events.some((event) => event.type === 'command/done'),
          60_000,
        );
        if (afterExit === null) throw new Error('the command never settled');
        const commands = permissionCommands(afterExit.events);
        expect(commands.at(-1)).toMatchObject({
          args: ' workspace-write',
          settled: 'success',
        });
        const exitView = await fetch(
          `${host.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(secondSessionId)}`,
          { headers: { cookie: `${host.cookie.name}=${host.cookie.value}` } },
        );
        const exitBody: unknown = await exitView.json();
        expect(exitBody).toMatchObject({
          admission: { enabled: false, managed: false },
        });
        // The host permission the user chose is untouched.
        expect(effectivePermission(afterExit.events)).toMatchObject({
          sandbox: 'workspace-write',
          approval: 'ask',
        });

        // A new call in the same session after the exit is ungated and runs,
        // even though it matches the deny rule. The page still owns this
        // session, so the call continues it instead of opening a new one.
        await sendPrompt(
          page,
          'ADM-AFTER-EXIT RUN echo arbiter-deny-after-exit',
        );
        const third = await waitForSession(
          host.home,
          (candidate) =>
            candidate.sessionId === secondSessionId &&
            candidate.events.some(
              (event) =>
                event.type === 'user/message' &&
                JSON.stringify(event.data).includes('ADM-AFTER-EXIT'),
            ) &&
            candidate.events.some((event) => event.type === 'turn/end'),
          90_000,
        );
        if (third === null) throw new Error('the post-exit call never settled');
        const thirdCalls = callsAfter(third, 'ADM-AFTER-EXIT');
        expect(thirdCalls.length).toBeGreaterThan(0);
        expect(decisionsFor(third, thirdCalls)).toHaveLength(0);
        // The call actually ran after the exit.
        expect(
          third.events.some(
            (event) =>
              event.type === 'tool/result' &&
              JSON.stringify(event.data).includes('arbiter-deny-after-exit') &&
              !JSON.stringify(event.data).includes('Not executed'),
          ),
        ).toBe(true);
      } finally {
        await caseHost.dispose();
      }
    },
  );

  test('the native auto entry is rejected before any permission write', async ({
    page,
  }, testInfo) => {
    const caseHost = await createCaseHost(testInfo.outputPath('dsh-auto'));
    try {
      const host = caseHost.current();
      const session = await runOneCall(
        page,
        host,
        'ADM-AUTO',
        'echo arbiter-auto-probe',
      );
      const enabled = await admissionRequest(host, {
        sessionId: session.sessionId,
        action: 'enable',
      });
      expect(enabled.status).toBe(200);
      const before = effectivePermission(session.events);
      const presetEventsBefore = session.events.filter(
        (event) => event.type === 'permission/preset',
      ).length;

      await openHost(page, host);
      await sendPrompt(page, '/permission auto');
      const settled = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.some((event) => event.type === 'command/done'),
        60_000,
      );
      if (settled === null) throw new Error('the auto command never settled');
      const commands = permissionCommands(settled.events);
      expect(commands.at(-1)).toMatchObject({
        args: ' auto',
        settled: 'error',
      });
      // No permission write happened, and the session is still admitted.
      expect(effectivePermission(settled.events)).toEqual(before);
      expect(
        settled.events.filter((event) => event.type === 'permission/preset')
          .length,
      ).toBe(presetEventsBefore);
      expect(lastAdmission(settled.events)).toMatchObject({ enabled: true });
      const view = await fetch(
        `${host.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(session.sessionId)}`,
        { headers: { cookie: `${host.cookie.name}=${host.cookie.value}` } },
      );
      const body = await recordBody(view);
      expect(body).toMatchObject({
        admission: { enabled: true, managed: true },
      });
    } finally {
      await caseHost.dispose();
    }
  });

  test('a cold restart with the audit database removed restores admission', async ({
    page,
  }, testInfo) => {
    const caseHost = await createCaseHost(testInfo.outputPath('dsh-restart'), {
      arbiterRowConfig: {
        rules: [
          {
            id: 'deny-marker',
            match: {
              node: 'command',
              kind: 'regex',
              pattern: '^echo arbiter-deny',
            },
            verdict: 'deny',
          },
        ],
      },
    });
    try {
      const first = caseHost.current();
      const session = await runOneCall(
        page,
        first,
        'ADM-RESTART',
        'echo arbiter-restart-warmup',
      );
      const enabled = await admissionRequest(first, {
        sessionId: session.sessionId,
        action: 'enable',
      });
      expect(enabled.status).toBe(200);
      const admittedRevision = String(admissionOf(enabled.body)['revision']);

      // Remove the audit database before the restart: admission must come from
      // the session log alone.
      await rm(join(first.home, 'arbiter'), {
        recursive: true,
        force: true,
      });

      const restarted = await caseHost.restart();
      // The session is not live until the client reopens it, so the first
      // read after a restart is expected to be authoritative-but-empty …
      const coldView = await fetch(
        `${restarted.origin}/api/arbiter/sessions?sessionId=${encodeURIComponent(session.sessionId)}`,
        {
          headers: {
            cookie: `${restarted.cookie.name}=${restarted.cookie.value}`,
          },
        },
      );
      expect(coldView.status).toBe(404);

      // … and the durable record is what the reopened session restores.
      await openHost(page, restarted);
      await openExistingSession(page, 'ADM-RESTART');
      const body = (await liveAdmission(restarted, session.sessionId)).body;
      expect(body).toMatchObject({
        ok: true,
        admission: {
          sessionId: session.sessionId,
          enabled: true,
          managed: true,
          boundary: 'guarded',
        },
      });
      // The revision is the backend-confirmed one, not a client guess.
      expect(admissionOf(body)['revision']).toBe(admittedRevision);

      // The restored admission still gates a real call.
      await sendPrompt(page, 'ADM-RESTART-2 RUN echo arbiter-deny-restored');
      const settled = await waitForSession(
        restarted.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.filter((event) => event.type === 'turn/end')
            .length >= 2,
        90_000,
      );
      if (settled === null) throw new Error('the restored call never settled');
      expect(decisionRecords(settled).length).toBeGreaterThan(0);
      expect(
        settled.events.some(
          (event) =>
            event.type === 'tool/result' &&
            JSON.stringify(event.data).includes('Not executed'),
        ),
      ).toBe(true);
    } finally {
      await caseHost.dispose();
    }
  });

  test('a trusted session writes outside the workspace and unload narrows it', async ({
    page,
  }, testInfo) => {
    const outside = join(testInfo.outputPath('dsh-trusted'), 'outside.txt');
    await mkdir(join(testInfo.outputPath('dsh-trusted')), { recursive: true });
    const caseHost = await createCaseHost(testInfo.outputPath('dsh-trusted'), {
      // Before policy: the call reaches review, and the deterministic reviewer
      // allows it. The effect is still the host's own sandbox decision.
      arbiterRowConfig: { boundary: 'trusted' },
    });
    try {
      const host = caseHost.current();
      const session = await runOneCall(
        page,
        host,
        'ADM-TRUSTED',
        'echo arbiter-trusted-warmup',
      );
      const enabled = await admissionRequest(host, {
        sessionId: session.sessionId,
        action: 'enable',
      });
      expect(enabled.status).toBe(200);
      expect(admissionOf(enabled.body)['boundary']).toBe('trusted');
      // The plugin applied the trusted bundle to the enabled session.
      const afterEnable = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          effectivePermission(candidate.events).sandbox ===
            'danger-full-access',
      );
      expect(afterEnable).not.toBeNull();

      await openHost(page, host);
      await sendPrompt(page, `ADM-TRUSTED-WRITE RUN printf 'ok' > ${outside}`);
      const wrote = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.filter((event) => event.type === 'turn/end')
            .length >= 2,
        90_000,
      );
      if (wrote === null) throw new Error('the trusted write never settled');
      // A real file outside the workspace is the effect, not the decision.
      expect(await readFile(outside, 'utf8')).toBe('ok');

      // A plugin disable narrows the session before it stops gating.
      const disabled = await admissionRequest(host, {
        sessionId: session.sessionId,
        action: 'disable',
      });
      expect(disabled.status).toBe(200);
      const afterDisable = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          effectivePermission(candidate.events).sandbox === 'workspace-write',
      );
      expect(afterDisable).not.toBeNull();
      expect(effectivePermission(afterDisable?.events ?? [])).toMatchObject({
        sandbox: 'workspace-write',
        approval: 'ask',
      });

      // The narrowed boundary now blocks the same write outside the workspace.
      const second = join(testInfo.outputPath('dsh-trusted'), 'outside-2.txt');
      await openHost(page, host);
      await sendPrompt(page, `ADM-TRUSTED-WRITE-2 RUN printf 'ok' > ${second}`);
      const blocked = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.filter((event) => event.type === 'turn/end')
            .length >= 3,
        90_000,
      );
      if (blocked === null) throw new Error('the narrowed write never settled');
      await expect(readFile(second, 'utf8')).rejects.toThrow();
    } finally {
      await caseHost.dispose();
    }
  });

  test('a subagent inherits an enabled parent and an unmanaged session stays ungated', async ({
    page,
  }, testInfo) => {
    const caseHost = await createCaseHost(testInfo.outputPath('dsh-subagent'), {
      arbiterRowConfig: {
        rules: [
          {
            id: 'deny-marker',
            match: {
              node: 'command',
              kind: 'regex',
              pattern: '^echo arbiter-deny',
            },
            verdict: 'deny',
          },
        ],
      },
    });
    try {
      const host = caseHost.current();
      const parent = await runOneCall(
        page,
        host,
        'ADM-PARENT',
        'echo arbiter-parent-warmup',
      );
      const enabled = await admissionRequest(host, {
        sessionId: parent.sessionId,
        action: 'enable',
      });
      expect(enabled.status).toBe(200);

      // A second, unmanaged session in the same profile: it stays ungated even
      // though another session in the same host is enabled.
      await openHost(page, host);
      await newSession(page);
      await sendPrompt(page, 'ADM-PLAIN RUN echo arbiter-deny-plain');
      const plainSession = await sessionWithText(host, 'ADM-PLAIN');
      const plain = await settledTurn(host, plainSession.sessionId);
      expect(plain.sessionId).not.toBe(parent.sessionId);
      expect(decisionRecords(plain)).toHaveLength(0);

      // A real delegation: the child session is host-managed, carries
      // `parentSession`, and the plugin must follow the parent's admission
      // instead of demanding its own record.
      await openHost(page, host);
      await openExistingSession(page, 'ADM-PARENT');
      await sendPrompt(page, 'ADM-DELEGATE DELEGATE echo arbiter-deny-child');
      const child = await waitForSession(
        host.home,
        (candidate) =>
          candidate.header?.['parentSession'] === parent.sessionId &&
          candidate.events.some(
            (event) => event.type === 'plugin:arbiter/decision',
          ),
        90_000,
      );
      expect(child).not.toBeNull();
      const childDecisions = child === null ? [] : decisionRecords(child);
      expect(childDecisions.length).toBeGreaterThan(0);
      expect(childDecisions[0]).toContain('deny-rule');
      // The child's own knobs are the host's delegation decision: the plugin
      // never widened or rewrote them.
      const childModes = (child?.events ?? []).filter(
        (event) => event.type === 'sandbox/mode',
      );
      expect(childModes.map((event) => JSON.stringify(event.data))).toEqual([
        JSON.stringify({ mode: 'workspace-write', source: 'delegation' }),
      ]);
      // And the parent's own decision for the delegation stays recorded: the
      // delegation is the parent's call, reviewed under the parent's mode.
      const parentAfter = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === parent.sessionId &&
          candidate.events.some(
            (event) =>
              event.type === 'tool/call' &&
              JSON.stringify(event.data).includes('"name":"subagent"'),
          ),
        90_000,
      );
      expect(parentAfter).not.toBeNull();
      const parentDecisions = decisionRecords(parentAfter ?? parent);
      expect(parentDecisions.some((entry) => entry.includes('subagent'))).toBe(
        true,
      );
    } finally {
      await caseHost.dispose();
    }
  });

  test('a read-only session is not rewritten when the plugin unloads', async ({
    page,
  }, testInfo) => {
    const caseHost = await createCaseHost(testInfo.outputPath('dsh-readonly'));
    try {
      const host = caseHost.current();
      const session = await runOneCall(
        page,
        host,
        'ADM-READONLY',
        'echo arbiter-readonly-warmup',
      );
      const enabled = await admissionRequest(host, {
        sessionId: session.sessionId,
        action: 'enable',
      });
      expect(enabled.status).toBe(200);

      await openHost(page, host);
      await sendPrompt(page, '/permission read-only');
      const switched = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.some((event) => event.type === 'command/done'),
        60_000,
      );
      if (switched === null) throw new Error('the switch never settled');
      const beforeRestart = effectivePermission(switched.events);
      expect(beforeRestart.sandbox).toBe('read-only');

      // A restart is an unload followed by a fresh plugin: the read-only
      // session must keep its own permission rather than being rewritten.
      const restarted = await caseHost.restart();
      const after = await waitForSession(
        restarted.home,
        (candidate) => candidate.sessionId === session.sessionId,
      );
      expect(after).not.toBeNull();
      expect(effectivePermission(after?.events ?? [])).toEqual(beforeRestart);
      // Leaving through the native command also stopped admission.
      expect(lastAdmission(after?.events ?? [])).toMatchObject({
        enabled: false,
      });
    } finally {
      await caseHost.dispose();
    }
  });
});
