import { randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, type Page } from '@playwright/test';
import { AuditStore, resolveAuditPath } from '../../../src/audit.js';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { createCaseHost, type CaseHost } from './case-host.js';
import type { DshHost } from './host.js';
import { waitForSession, type LoggedSession } from './session-log.js';
import { record, text, type Config } from './workflow-fixture/protocol.js';
export { record } from './workflow-fixture/protocol.js';

export function allowedTool(
  id: string,
  tool: string,
  path: string,
  pattern: string,
) {
  return {
    id,
    scope: { tools: [tool] },
    conditions: [{ target: 'argument', path, kind: 'exact', pattern }],
    verdict: 'allow',
  };
}
export async function workflowHost(
  directory: string,
  scenario: Config['scenario'],
  scores: Readonly<Record<string, readonly [number, number]>>,
  options: {
    readonly rules?: readonly Record<string, unknown>[];
    readonly remoteEvents?: false;
  } = {},
): Promise<CaseHost> {
  await mkdir(directory, { recursive: true });
  await writeFile(
    join(directory, 'result-marker.txt'),
    `CW126_RETURN_${randomUUID()}`,
  );
  const tracePath = join(directory, 'lifecycle.jsonl');
  const fixture =
    'file://' +
    fileURLToPath(new URL('./workflow-fixture/index.ts', import.meta.url));
  return createCaseHost(directory, {
    agentModel: { provider: 'arbiter-workflow-agent', model: 'workflow' },
    tracePath,
    arbiterRowConfig: {
      format: 'arbiter-config-v3',
      modes: {
        main: 'ask',
        subagent: 'no-ask',
      },
      reviewer: {
        chat: { provider: 'arbiter-workflow-reviewer', model: 'workflow' },
      },
      rules: options.rules ?? [],
    },
    extraRows: [
      {
        insert: [
          {
            id: 'workflow-fixture',
            name: fixture,
            config: { scenario, directory, tracePath, scores },
          },
        ],
      },
      ...(options.remoteEvents === false
        ? [{ id: 'api-remotes', disabled: true }]
        : []),
      ...(scenario === 'timed'
        ? [
            {
              id: 'preset-standard',
              config: {
                id: 'standard',
                order: 0,
                plugins: [
                  {
                    id: 'tool-ask-user',
                    name: '@deepseek-ai/dsh-tool-ask-user',
                    config: { mode: 'timed', timeout: 1 },
                  },
                ],
              },
            },
          ]
        : []),
    ],
  });
}
export async function openWorkflow(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  for (const pattern of [/预览版说明|Preview/iu, /开始使用|Get started/iu]) {
    const dialog = page.getByRole('dialog', { name: pattern });
    if (await dialog.isVisible().catch(() => false))
      await dialog
        .getByRole('button', { name: /^(继续|Continue|关闭|Close)$/u })
        .first()
        .click();
  }
}
export async function sendWorkflow(page: Page, value: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(value);
  await page.keyboard.press('Enter');
}
export async function completedWorkflow(
  host: DshHost,
  marker: string,
): Promise<LoggedSession> {
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
    90000,
  );
  if (session === null) throw new Error(`workflow never settled: ${marker}`);
  return session;
}
export async function warmWorkflow(page: Page, host: DshHost): Promise<string> {
  await openWorkflow(page, host);
  await sendWorkflow(page, 'CW126-WARM');
  const warm = await completedWorkflow(host, 'CW126-WARM');
  const response = await page.request.post(
    `${host.origin}/api/arbiter/sessions`,
    { data: { sessionId: warm.sessionId, action: 'enable' } },
  );
  expect(response.status()).toBe(200);
  expect(record(record(await response.json())['admission'])['managed']).toBe(
    true,
  );
  return warm.sessionId;
}
export function workflowCall(session: LoggedSession, stage: string) {
  const event = session.events.find(
    (entry) =>
      entry.type === 'tool/call' &&
      String(record(entry.data)['callId']).startsWith(`cw126-${stage}-`),
  );
  if (event === undefined) throw new Error(`missing actual call ${stage}`);
  const id = record(event.data)['callId'];
  if (typeof id !== 'string') throw new Error('missing call identity');
  return { id, event };
}
export function workflowResult(session: LoggedSession, id: string) {
  const event = session.events.find(
    (entry) =>
      entry.type === 'tool/result' &&
      record(record(entry.data)['message'])['toolCallId'] === id,
  );
  if (event === undefined) throw new Error(`missing actual result ${id}`);
  return { event, message: record(record(event.data)['message']) };
}
export function workflowDecision(session: LoggedSession, id: string) {
  return session.events
    .filter(
      (event) =>
        event.type === 'plugin:arbiter/decision' &&
        record(event.data)['callId'] === id,
    )
    .map((event) => record(event.data));
}
export function readAudit<T>(host: DshHost, read: (audit: AuditStore) => T): T {
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
export function workflowSnapshot(host: DshHost, id: string) {
  const row = readAudit(host, (audit) => audit.getCall(id));
  expect(row, `actual audit row ${id}`).not.toBeNull();
  const snapshot = record(row?.['snapshot']);
  expect(snapshot['callId']).toBe(id);
  return snapshot;
}
export function prefixEvents(
  snapshot: Record<string, unknown>,
  source: 'local' | 'parent' = 'local',
) {
  const events = record(record(snapshot['prefix'])[source])['events'];
  if (!Array.isArray(events)) throw new Error(`missing ${source} prefix`);
  return events.map((event: unknown) => record(event));
}
export async function workflowWires(directory: string) {
  const path = join(directory, 'reviewer');
  const files = await readdir(path).catch(() => [] as string[]);
  return Promise.all(
    files
      .sort()
      .map(async (file) =>
        record(JSON.parse(await readFile(join(path, file), 'utf8'))),
      ),
  );
}
export async function workflowWire(directory: string, id: string) {
  const wires = (await workflowWires(directory)).filter(
    (entry) => entry['callId'] === id,
  );
  expect(wires, `one real reviewer request for ${id}`).toHaveLength(1);
  const wire = record(wires[0]);
  const request = record(wire['request']);
  const messages = request['messages'];
  if (!Array.isArray(messages)) throw new Error('missing reviewer messages');
  return {
    ...wire,
    text: messages
      .map((message: unknown) => text(record(message)['content']))
      .join('\n'),
  };
}
export async function executions(
  directory: string,
): Promise<readonly string[]> {
  const data = await readFile(
    join(directory, 'executions.jsonl'),
    'utf8',
  ).catch(() => '');
  return data
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const stage = record(JSON.parse(line))['stage'];
      if (typeof stage !== 'string')
        throw new Error('invalid execution identity');
      return stage;
    });
}
export async function captureWorkflow(
  caseHost: CaseHost,
  directory: string,
): Promise<void> {
  try {
    const sessions = await caseHost.logs();
    await writeFile(
      join(directory, 'native-sessions.json'),
      JSON.stringify(sessions, null, 2),
    );
    const host = caseHost.current();
    await writeFile(
      join(directory, 'isolated-profile.patch.yml'),
      await readFile(host.documentPath, 'utf8'),
    );
    const calls = readAudit(host, (audit) => {
      const page = audit.listCalls({ limit: 100 });
      return {
        ...page,
        records: page.rows.map((row) => audit.getCall(row.callId)),
      };
    });
    await writeFile(
      join(directory, 'audit-calls.json'),
      JSON.stringify(calls, null, 2),
    );
  } finally {
    await caseHost.dispose();
  }
}
