/** Actual shell, runtime output, storage fault and cold source recovery in one private host. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';
import { AuditStore, resolveAuditPath } from '../../src/audit.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { createCaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { waitForSession, type LoggedSession } from './dsh/session-log.js';

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('expected record');
  return { ...value };
}
async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  for (const pattern of [/预览版说明|Preview/i, /开始使用|Get started/i]) {
    const dialog = page.getByRole('dialog', { name: pattern });
    if (await dialog.isVisible().catch(() => false))
      await dialog
        .getByRole('button', { name: /^(继续|Continue|关闭|Close)$/ })
        .first()
        .click();
  }
}
async function send(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}
async function settled(host: DshHost, marker: string): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) => {
      const user = candidate.events.findLast(
        (event) =>
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes(marker),
      );
      return (
        user !== undefined &&
        candidate.events.some(
          (event) =>
            event.type === 'turn/end' && (event.seq ?? -1) > (user.seq ?? -1),
        )
      );
    },
    90_000,
  );
  if (session === null) throw new Error(`turn never settled: ${marker}`);
  return session;
}
function callId(session: LoggedSession, marker: string): string {
  const call = session.events.findLast(
    (event) =>
      event.type === 'tool/call' &&
      JSON.stringify(record(event.data)['arguments']).includes(marker),
  );
  const id = call === undefined ? undefined : record(call.data)['callId'];
  if (typeof id !== 'string') throw new Error(`no call ${marker}`);
  return id;
}
async function admission(
  host: DshHost,
  sessionId: string,
  action: 'enable' | 'disable',
): Promise<void> {
  const response = await fetch(`${host.origin}/api/arbiter/sessions`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, action }),
  });
  expect(response.status).toBe(200);
  expect(record(record(await response.json())['admission'])['managed']).toBe(
    action === 'enable',
  );
}
async function reviewCount(path: string): Promise<number> {
  const text = await readFile(path, 'utf8').catch(() => '');
  return text
    .split('\n')
    .filter((line) => line.includes('"event":"review/start"')).length;
}
function auditRead<T>(host: DshHost, read: (audit: AuditStore) => T): T {
  const audit = new AuditStore(
    resolveAuditPath(host.home),
    DEFAULT_CONFIG.audit,
  );
  try {
    return read(audit);
  } finally {
    audit.close();
  }
}

test('collects unreviewed ls and final outputs, contains storage failures, restores sources after a real restart', async ({
  page,
}, testInfo) => {
  test.setTimeout(600_000);
  const artifacts = testInfo.outputPath('result-collection');
  await mkdir(artifacts, { recursive: true });
  const trace = join(artifacts, 'lifecycle.jsonl');
  const caseHost = await createCaseHost(artifacts, {
    tracePath: trace,
    arbiterRowConfig: {
      format: 'arbiter-config-v3',
      boundary: 'trusted',
      context: { maxInputTokens: 50_000 },
      rules: [
        {
          id: 'ls-query',
          scope: { tools: ['bash'] },
          conditions: [
            { target: 'command', kind: 'regex', pattern: '^ls(?: .*)?$' },
          ],
          verdict: 'allow',
        },
        {
          id: 'result-fixture',
          scope: { tools: ['result_probe'] },
          conditions: [
            {
              target: 'argument',
              path: '$.case',
              kind: 'regex',
              pattern: '.*',
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
            id: 'arbiter-result-probe',
            name:
              'file://' +
              fileURLToPath(
                new URL('./dsh/result-probe/index.ts', import.meta.url),
              ),
          },
        ],
      },
    ],
  });
  try {
    let host = caseHost.current();
    await openHost(page, host);
    await send(page, 'CW122-WARM RUN echo cw122-warm');
    const warm = await settled(host, 'CW122-WARM');
    const sessionId = warm.sessionId;
    expect(
      warm.events.some(
        (event) => event.type === 'plugin:arbiter/result-reference',
      ),
    ).toBe(false);
    await admission(host, sessionId, 'enable');
    await writeFile(
      join(host.workspace, 'CW122_LISTING_FILE.txt'),
      'listing fixture',
    );
    await send(page, `CW122-LS RUN ls '${host.workspace}'`);
    const listed = await settled(host, 'CW122-LS');
    const lsId = callId(listed, 'ls ');
    const listing = auditRead(host, (audit) =>
      audit.getToolResult(sessionId, lsId),
    );
    expect(listing.state).toBe('found');
    expect(JSON.stringify(listing.fragments)).toContain(
      'CW122_LISTING_FILE.txt',
    );
    expect(await reviewCount(trace)).toBe(0);
    const reference = listed.events.find(
      (event) =>
        event.type === 'plugin:arbiter/result-reference' &&
        record(event.data)['callId'] === lsId,
    );
    const native = listed.events.find(
      (event) =>
        event.type === 'tool/result' &&
        JSON.stringify(event.data).includes(lsId),
    );
    expect(reference?.seq).toBeGreaterThan(
      listed.events.find(
        (event) =>
          event.type === 'tool/call' && record(event.data)['callId'] === lsId,
      )?.seq ?? -1,
    );
    expect(reference?.seq).toBeLessThan(native?.seq ?? -1);
    const matrix: Record<string, unknown> = { listing };
    for (const [kind, status, contentState] of [
      ['failure', 'failure', 'available'],
      ['empty', 'success', 'empty'],
      ['media', 'success', 'unsupported'],
      ['multi', 'success', 'available'],
      ['credential', 'success', 'available'],
    ] as const) {
      const marker = `CW122-${kind}`;
      await send(page, `${marker} RUN RESULT:${kind}`);
      const session = await settled(host, marker);
      const id = callId(session, kind);
      const output = auditRead(host, (audit) =>
        audit.getToolResult(sessionId, id),
      );
      expect(output.state).toBe('found');
      expect(output.metadata, JSON.stringify(output)).toMatchObject({
        status,
        contentState,
      });
      expect(JSON.stringify(output)).not.toContain('CW122_MEDIA_SENTINEL');
      expect(JSON.stringify(output)).not.toContain('opaque-workflow-secret-42');
      if (kind === 'multi')
        expect(output.metadata?.parts.map((part) => part.channel)).toEqual([
          'stdout',
          'stderr',
        ]);
      matrix[kind] = output;
    }
    expect(await reviewCount(trace)).toBe(0);
    const db = new DatabaseSync(resolveAuditPath(host.home));
    try {
      db.exec(
        "CREATE TRIGGER cw122_fail_result BEFORE INSERT ON tool_results BEGIN SELECT RAISE(FAIL, 'controlled-result-failure'); END",
      );
      await send(page, 'CW122-STORAGE RUN RESULT:success');
      const failed = await settled(host, 'CW122-STORAGE');
      const failedId = callId(failed, 'success');
      const ref = failed.events.find(
        (event) =>
          event.type === 'plugin:arbiter/result-reference' &&
          record(event.data)['callId'] === failedId,
      );
      expect(record(ref?.data)['save']).toBe('failed');
      const result = failed.events.find(
        (event) =>
          event.type === 'tool/result' &&
          JSON.stringify(event.data).includes(failedId),
      );
      expect(JSON.stringify(result?.data)).toContain('CW122_PROBE_SUCCESS');
      matrix['storageFailure'] = ref;
    } finally {
      db.exec('DROP TRIGGER cw122_fail_result');
      db.close();
    }
    await send(page, 'CW122-PARALLEL RUN RESULT:slow\nRUN2 RESULT:success');
    const parallel = await settled(host, 'CW122-PARALLEL');
    const lateId = callId(parallel, 'slow');
    expect(
      JSON.stringify(
        auditRead(host, (audit) => audit.getToolResult(sessionId, lateId))
          .fragments,
      ),
    ).toContain('CW122_LATE_RESULT');
    await send(
      page,
      'CW122-HOT put opaque-workflow-secret-42 in ticket RUN echo cw122-hot',
    );
    const hot = await settled(host, 'CW122-HOT');
    const hotId = callId(hot, 'cw122-hot');
    const firstReview = auditRead(host, (audit) => audit.getCall(hotId));
    expect(firstReview?.['snapshot']).not.toBeNull();
    const frozen = JSON.stringify(firstReview?.['snapshot']);
    expect(frozen).toContain('CW122_LISTING_FILE.txt');
    expect(frozen).not.toContain('opaque-workflow-secret-42');
    expect(frozen).not.toContain('CW122_MEDIA_SENTINEL');
    const local = record(
      record(record(firstReview?.['snapshot'])['prefix'])['local'],
    );
    const events = local['events'];
    if (!Array.isArray(events)) throw new Error('missing snapshot events');
    expect(
      events.some(
        (event: unknown) =>
          record(event)['kind'] === 'result' &&
          record(event)['callId'] === hotId,
      ),
    ).toBe(false);
    const hotSources = listing;
    host = await caseHost.restart();
    await openHost(page, host);
    await page
      .getByRole('treeitem', { name: /CW122-WARM/ })
      .first()
      .click();
    await expect(
      page.locator('[contenteditable="true"]').first(),
    ).toBeVisible();
    const coldSources = auditRead(host, (audit) =>
      audit.getToolResult(sessionId, lsId, listing.receipt ?? undefined),
    );
    expect(coldSources).toEqual(hotSources);
    await send(
      page,
      'CW122-COLD put opaque-workflow-secret-42 in ticket RUN echo cw122-cold',
    );
    const cold = await settled(host, 'CW122-COLD');
    const coldId = callId(cold, 'cw122-cold');
    const restored = auditRead(host, (audit) => audit.getCall(coldId));
    const coldSnapshot = JSON.stringify(restored?.['snapshot']);
    expect(coldSnapshot).toContain('CW122_LISTING_FILE.txt');
    expect(coldSnapshot).not.toContain('opaque-workflow-secret-42');
    expect(
      auditRead(host, (audit) =>
        JSON.stringify(audit.getCall(hotId)?.['snapshot']),
      ),
    ).toBe(frozen);
    await admission(host, sessionId, 'disable');
    await send(page, `CW122-DISABLED RUN ls '${host.workspace}'`);
    const disabled = await settled(host, 'CW122-DISABLED');
    const disabledId = callId(disabled, 'ls ');
    expect(
      auditRead(host, (audit) => audit.getToolResult(sessionId, disabledId))
        .state,
    ).toBe('absent');
    await writeFile(
      join(artifacts, 'evidence.json'),
      JSON.stringify(
        {
          sessionId,
          lsId,
          reference,
          native,
          matrix,
          lateId,
          hotId,
          coldId,
          disabledId,
          immutableSnapshot: true,
          coldReadExact: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await caseHost.dispose();
  }
});

test('real PTC collector unregisters on Loader unload and registers once after reload', async ({
  page,
}, testInfo) => {
  test.setTimeout(300_000);
  const artifacts = testInfo.outputPath('result-ptc-lifecycle');
  const caseHost = await createCaseHost(artifacts, {
    arbiterRowConfig: {
      format: 'arbiter-config-v3',
      boundary: 'trusted',
      rules: [
        {
          id: 'ptc-outer',
          scope: { tools: ['run_code'] },
          conditions: [
            {
              target: 'argument',
              path: '$.description',
              kind: 'exact',
              pattern: 'fixture PTC result',
            },
          ],
          verdict: 'allow',
        },
        {
          id: 'ptc-inner',
          scope: { tools: ['result_probe'] },
          conditions: [
            {
              target: 'argument',
              path: '$.case',
              kind: 'exact',
              pattern: 'success',
            },
          ],
          verdict: 'allow',
        },
      ],
    },
    extraRows: [
      { id: 'tools', config: { mode: 'ptc' } },
      {
        insert: [
          {
            id: 'arbiter-result-probe',
            name:
              'file://' +
              fileURLToPath(
                new URL('./dsh/result-probe/index.ts', import.meta.url),
              ),
          },
        ],
      },
    ],
  });
  try {
    const host = caseHost.current();
    await openHost(page, host);
    await send(page, 'CW122-PTC-WARM RUN RESULTPTC:success');
    const warm = await settled(host, 'CW122-PTC-WARM');
    await admission(host, warm.sessionId, 'enable');
    await send(page, 'CW122-PTC-ACTIVE RUN RESULTPTC:success');
    const active = await settled(host, 'CW122-PTC-ACTIVE');
    const activeId = callId(active, 'fixture PTC result');
    const refsFor = (session: LoggedSession, id: string) =>
      session.events.filter(
        (event) =>
          event.type === 'plugin:arbiter/result-reference' &&
          (record(event.data)['callId'] === id ||
            session.events.some(
              (start) =>
                start.type === 'tool/ptc-dispatch-start' &&
                record(start.data)['rootCallId'] === id &&
                record(start.data)['subCallId'] ===
                  record(event.data)['callId'],
            )),
      );
    const activeRefs = refsFor(active, activeId);
    expect(activeRefs).toHaveLength(2);
    for (const ref of activeRefs) {
      const id = record(ref.data)['callId'];
      if (typeof id !== 'string') throw new Error('missing PTC call');
      expect(
        auditRead(host, (audit) => audit.getToolResult(warm.sessionId, id))
          .state,
      ).toBe('found');
    }
    const original = await readFile(host.documentPath, 'utf8');
    const patch: unknown = original.trimStart().startsWith('[')
      ? JSON.parse(original)
      : null;
    const head = Array.isArray(patch)
      ? patch
          .map((row: unknown) => `- ${JSON.stringify(record(row))}`)
          .join('\n')
      : original;
    await writeFile(
      host.documentPath,
      `${head}\n- id: arbiter\n  disabled: true\n`,
    );
    const status = async () =>
      (
        await fetch(`${host.origin}/api/arbiter/state`, {
          headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
        })
      ).status;
    await expect.poll(status).toBe(404);
    await send(page, 'CW122-PTC-UNLOADED RUN RESULTPTC:success');
    const unloaded = await settled(host, 'CW122-PTC-UNLOADED');
    const unloadedId = callId(unloaded, 'fixture PTC result');
    expect(refsFor(unloaded, unloadedId)).toHaveLength(0);
    expect(
      auditRead(host, (audit) =>
        audit.getToolResult(warm.sessionId, unloadedId),
      ).state,
    ).toBe('absent');
    const native = unloaded.events.find(
      (event) =>
        event.type === 'tool/result' &&
        JSON.stringify(event.data).includes(unloadedId),
    );
    expect(JSON.stringify(native?.data)).toContain('CW122_PROBE_SUCCESS');
    await writeFile(host.documentPath, original);
    await expect.poll(status).toBe(200);
    await admission(host, warm.sessionId, 'enable');
    await send(page, 'CW122-PTC-RELOADED RUN RESULTPTC:success');
    const reloaded = await settled(host, 'CW122-PTC-RELOADED');
    const reloadedId = callId(reloaded, 'fixture PTC result');
    expect(refsFor(reloaded, reloadedId)).toHaveLength(2);
    await writeFile(
      join(artifacts, 'evidence.json'),
      JSON.stringify(
        {
          activeRefs,
          unloadedId,
          reloadedRefs: refsFor(reloaded, reloadedId),
          realLoaderUnload: true,
          afterUnloadToolUnchanged: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await caseHost.dispose();
  }
});
