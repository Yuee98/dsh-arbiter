import { randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  captureWorkflow,
  completedWorkflow,
  executions,
  prefixEvents,
  readAudit,
  record,
  sendWorkflow,
  warmWorkflow,
  workflowCall,
  workflowDecision,
  workflowHost,
  workflowResult,
  workflowSnapshot,
  workflowWire,
  workflowWires,
} from './dsh/workflow-host.js';

for (const outcome of ['approve', 'reject', 'abort'] as const) {
  test(`an escalated call remains unexecuted while unanswered and settles by native ${outcome}`, async ({
    page,
  }, info) => {
    const directory = info.outputPath('approval');
    const caseHost = await workflowHost(directory, 'approval', {
      C: [5, 2],
      D: [5, 2],
    });
    try {
      const host = caseHost.current();
      const sessionId = await warmWorkflow(page, host);
      await sendWorkflow(
        page,
        'CW126-START：先检查 C，收到实际结果后再独立检查 D。',
      );
      const approval = page.locator('[data-approval-key]');
      await expect(approval).toBeVisible({ timeout: 60000 });
      await expect(
        approval.getByRole('button', { name: '允许一次', exact: true }),
      ).toBeEnabled();
      const pending = await workflowWires(directory);
      expect(pending).toHaveLength(1);
      const id = record(pending[0])['callId'];
      if (typeof id !== 'string')
        throw new Error('approval lacks actual review identity');
      const original = await workflowWire(directory, id);
      expect(await executions(directory)).toEqual([]);
      await expect(
        readFile(join(directory, 'C-effect.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        (await caseHost.logs())
          .find((session) => session.sessionId === sessionId)
          ?.events.some(
            (event) =>
              event.type === 'tool/result' &&
              record(record(event.data)['message'])['toolCallId'] === id,
          ),
      ).toBe(false);
      if (outcome === 'abort') {
        await expect(
          page.getByRole('button', { name: '停止生成', exact: true }),
        ).toHaveCount(0);
        const cancelled = await page.request.post(
          `${host.origin}/api/session/cancel`,
          {
            data: {
              type: 'client-request',
              rpcId: randomUUID(),
              method: 'session/cancel',
              payload: { args: { request: { sessionId } } },
            },
          },
        );
        expect(cancelled.status()).toBe(200);
        await writeFile(
          join(directory, 'native-cancel.json'),
          JSON.stringify(await cancelled.json(), null, 2),
        );
      } else {
        await approval
          .getByRole('button', {
            name: outcome === 'approve' ? '允许一次' : '拒绝',
            exact: true,
          })
          .click();
      }
      if (outcome === 'approve') {
        // D gets its own review and native approval; C's approval authorizes C once.
        await expect
          .poll(async () => (await workflowWires(directory)).length)
          .toBe(2);
        await expect(approval).toBeVisible();
        expect(await executions(directory)).toEqual(['C']);
        expect(await readFile(join(directory, 'C-effect.txt'), 'utf8')).toBe(
          'C',
        );
        await expect(
          readFile(join(directory, 'D-effect.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        await approval
          .getByRole('button', { name: '拒绝', exact: true })
          .click();
      }
      const session = await completedWorkflow(host, 'CW126-START');
      const expected =
        outcome === 'approve'
          ? 'human-allow'
          : outcome === 'reject'
            ? 'human-deny'
            : 'human-abort';
      expect(workflowDecision(session, id)).toMatchObject([
        { result: expected },
      ]);
      const audit = readAudit(host, (store) => store.getCall(id));
      expect(audit?.['result']).toBe(expected);
      expect(record(audit?.['scores'])['verdict']).toBe('review-escalate');
      expect(await workflowWire(directory, id)).toEqual(original);
      if (outcome === 'approve') {
        const c = workflowCall(session, 'C');
        const d = workflowCall(session, 'D');
        const result = workflowResult(session, c.id);
        expect(result.message['isError']).toBe(false);
        expect(d.event.seq).toBeGreaterThan(result.event.seq ?? -1);
        expect(workflowDecision(session, d.id)).toMatchObject([
          { result: 'human-deny' },
        ]);
        expect(workflowResult(session, d.id).message['isError']).toBe(true);
        const snapshot = workflowSnapshot(host, d.id);
        expect(prefixEvents(snapshot)).toContainEqual(
          expect.objectContaining({
            kind: 'result',
            callId: c.id,
            status: 'success',
          }),
        );
        const wire = await workflowWire(directory, d.id);
        expect(wire.text).toContain(c.id);
        expect(wire.text).toContain(
          await readFile(join(directory, 'result-marker.txt'), 'utf8'),
        );
        expect(await executions(directory)).toEqual(['C']);
        expect(await workflowWires(directory)).toHaveLength(2);
      } else {
        expect(await executions(directory)).toEqual([]);
        await expect(
          readFile(join(directory, 'C-effect.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await workflowWires(directory)).toHaveLength(1);
        const results = session.events.filter(
          (event) =>
            event.type === 'tool/result' &&
            record(record(event.data)['message'])['toolCallId'] === id,
        );
        for (const result of results)
          expect(record(record(result.data)['message'])['isError']).toBe(true);
      }
      await expect(
        readFile(join(directory, 'D-effect.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      await writeFile(
        join(directory, 'proof.json'),
        JSON.stringify(
          {
            sessionId,
            callId: id,
            unansweredDidNotExecute: true,
            outcome: expected,
            reviewStage: 'review-escalate',
            actualReviewerRequests: (await workflowWires(directory)).length,
            executions: await executions(directory),
          },
          null,
          2,
        ),
      );
    } finally {
      await captureWorkflow(caseHost, directory);
    }
  });
}

test('a missing native approval answerer settles as fallback rather than a human answer', async ({
  page,
}, info) => {
  const directory = info.outputPath('approval-unavailable');
  const caseHost = await workflowHost(
    directory,
    'approval',
    { C: [5, 2], D: [5, 2] },
    { remoteEvents: false },
  );
  try {
    const host = caseHost.current();
    await page
      .context()
      .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
    const rpc = async (method: string, args: Record<string, unknown>) => {
      const response = await page.request.post(`${host.origin}/api/${method}`, {
        data: {
          type: 'client-request',
          rpcId: randomUUID(),
          method,
          payload: { args },
        },
      });
      expect(response.status()).toBe(200);
      const result = record(record(await response.json())['result']);
      expect(result['ok']).toBe(true);
      return record(result['value']);
    };
    const created = await rpc('session/create', {
      request: { cwd: host.workspace, agentPreset: 'standard' },
    });
    const sessionId = created['sessionId'];
    if (typeof sessionId !== 'string')
      throw new Error('native session creation failed');
    const prompt = (value: string) =>
      rpc('session/prompt', {
        request: {
          requestId: randomUUID(),
          sessionId,
          mode: 'queue',
          content: [{ type: 'text', text: value }],
        },
      });
    await prompt('CW126-WARM');
    expect((await completedWorkflow(host, 'CW126-WARM')).sessionId).toBe(
      sessionId,
    );
    const enabled = await page.request.post(
      `${host.origin}/api/arbiter/sessions`,
      { data: { sessionId, action: 'enable' } },
    );
    expect(enabled.status()).toBe(200);
    expect(record(record(await enabled.json())['admission'])['managed']).toBe(
      true,
    );
    await prompt('CW126-START：检查 C；此隔离宿主没有配置审批答复通道。');
    const session = await completedWorkflow(host, 'CW126-START');
    const call = workflowCall(session, 'C');
    const asked = session.events.find(
      (event) =>
        event.type === 'approval/asked' &&
        record(event.data)['callId'] === call.id,
    );
    expect(asked).toBeDefined();
    const decided = session.events.find(
      (event) =>
        event.type === 'approval/decided' &&
        record(event.data)['id'] === record(asked?.data)['id'],
    );
    expect(record(decided?.data)['outcome']).toBe('unavailable');
    expect(workflowDecision(session, call.id)).toMatchObject([
      { result: 'fallback-deny' },
    ]);
    expect(workflowResult(session, call.id).message['isError']).toBe(true);
    const audit = readAudit(host, (store) => store.getCall(call.id));
    expect(audit?.['result']).toBe('fallback-deny');
    expect(record(audit?.['scores'])['verdict']).toBe('review-escalate');
    expect(audit?.['reason']).toEqual(expect.stringContaining('unavailable'));
    expect(await executions(directory)).toEqual([]);
    await expect(
      readFile(join(directory, 'C-effect.txt')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await workflowWires(directory)).toHaveLength(1);
    await workflowWire(directory, call.id);
    await writeFile(
      join(directory, 'proof.json'),
      JSON.stringify(
        {
          driver:
            'native session RPC; api-remotes answerer absent from isolated profile',
          sessionId,
          callId: call.id,
          outcome: audit?.['result'],
          reason: audit?.['reason'],
          executions: await executions(directory),
        },
        null,
        2,
      ),
    );
  } finally {
    await captureWorkflow(caseHost, directory);
  }
});
