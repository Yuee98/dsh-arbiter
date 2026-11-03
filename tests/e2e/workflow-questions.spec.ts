import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import {
  allowedTool,
  captureWorkflow,
  completedWorkflow,
  executions,
  prefixEvents,
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
import { waitForSession } from './dsh/session-log.js';
import { text } from './dsh/workflow-fixture/protocol.js';

const askRule = allowedTool(
  'native-question',
  'ask_user_question',
  '$.questions[0].id',
  'sample-only',
);
for (const answer of ['允许 sample 文件', '不允许']) {
  test(`an actual denied attempt asks, binds ${answer}, and continues its original trajectory`, async ({
    page,
  }, info) => {
    const directory = info.outputPath('questions');
    const caseHost = await workflowHost(
      directory,
      'ask',
      { P1: [5, 1], P2: [2, 8], P3: [5, 1] },
      { rules: [askRule] },
    );
    try {
      const host = caseHost.current();
      const sessionId = await warmWorkflow(page, host);
      await writeFile(join(directory, 'workspace.txt'), host.workspace);
      await writeFile(join(host.workspace, 'sample.txt'), 'CW126_SAMPLE_BODY');
      await writeFile(join(host.workspace, 'full.txt'), 'CW126_FULL_BODY');
      await sendWorkflow(
        page,
        'CW126-START：禁止交付任何文件；如需 sample 的局部例外，请先询问。',
      );
      const card = page.getByRole('radiogroup').first();
      await expect(card).toBeVisible({ timeout: 60000 });
      // The unauthorized physical attempt really happened before the question.
      const waiting = await waitForSession(
        host.home,
        (candidate) =>
          candidate.sessionId === sessionId &&
          candidate.events.some(
            (event) =>
              event.type === 'tool/call' &&
              String(record(event.data)['callId']).startsWith(
                'cw126-question-',
              ),
          ),
      );
      if (waiting === null)
        throw new Error('native question was not committed');
      const p1 = workflowCall(waiting, 'P1');
      const question = workflowCall(waiting, 'question');
      const denied = workflowResult(waiting, p1.id);
      expect(denied.message['isError']).toBe(true);
      expect(denied.event.seq).toBeLessThan(question.event.seq ?? -1);
      expect(workflowDecision(waiting, p1.id)).toMatchObject([
        { result: 'review-deny' },
      ]);
      await expect(
        readFile(join(host.workspace, 'sample-delivery.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      const original = JSON.stringify(workflowSnapshot(host, p1.id));
      await card.getByRole('radio', { name: answer, exact: true }).click();
      await page.getByRole('button', { name: '提交', exact: true }).click();
      const session = await completedWorkflow(host, 'CW126-START');
      const bound = workflowResult(session, question.id);
      expect(JSON.stringify(bound.message['content'])).toContain(answer);
      expect(record(bound.message['source'])['callId']).toBe(question.id);
      expect(JSON.stringify(workflowSnapshot(host, p1.id))).toBe(original);
      expect((await workflowWire(directory, p1.id)).text).not.toContain(
        'CW126_SAMPLE_BODY',
      );
      if (answer === '允许 sample 文件') {
        const p2 = workflowCall(session, 'P2');
        const p3 = workflowCall(session, 'P3');
        expect(p2.event.seq).toBeGreaterThan(bound.event.seq ?? -1);
        expect(record(p2.event.data)['arguments']).toEqual(
          record(p1.event.data)['arguments'],
        );
        expect(
          await readFile(join(host.workspace, 'sample-delivery.txt'), 'utf8'),
        ).toBe('CW126_SAMPLE_BODY');
        expect(workflowResult(session, p2.id).message['isError']).toBe(false);
        expect(workflowResult(session, p3.id).message['isError']).toBe(true);
        expect(workflowDecision(session, p2.id)).toMatchObject([
          { result: 'review-allow' },
        ]);
        expect(workflowDecision(session, p3.id)).toMatchObject([
          { result: 'review-deny' },
        ]);
        const snapshot = workflowSnapshot(host, p2.id);
        const events = prefixEvents(snapshot);
        expect(events).toContainEqual(
          expect.objectContaining({
            kind: 'human',
            binding: expect.objectContaining({
              askId: question.id,
              status: 'bound',
              answerIds: ['sample-only'],
            }),
          }),
        );
        expect(events.some((event) => event['callId'] === p2.id)).toBe(false);
        const wire = await workflowWire(directory, p2.id);
        expect(wire.text).toContain('sample-only');
        expect(wire.text).toContain(answer);
        expect(wire.text).toContain(p1.id);
        await workflowWire(directory, p3.id);
        expect(await workflowWires(directory)).toHaveLength(3);
      } else {
        expect(
          session.events.filter((event) => event.type === 'tool/call'),
        ).toHaveLength(2);
        await expect(
          readFile(join(host.workspace, 'sample-delivery.txt')),
        ).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await workflowWires(directory)).toHaveLength(1);
      }
      await expect(
        readFile(join(host.workspace, 'full-delivery.txt')),
      ).rejects.toMatchObject({ code: 'ENOENT' });
      expect(
        session.events.filter(
          (event) =>
            event.type === 'user/message' &&
            record(record(event.data)['source'])['kind'] === 'user',
        ),
      ).toHaveLength(2);
      expect(workflowDecision(session, question.id)).not.toContainEqual(
        expect.objectContaining({ result: 'human-allow' }),
      );
      await writeFile(
        join(directory, 'proof.json'),
        JSON.stringify(
          {
            sessionId,
            answer,
            p1: p1.id,
            askId: question.id,
            boundAnswer: bound.event,
            actualReviewerRequests: (await workflowWires(directory)).length,
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

test('a timed pending question continues, then its actual late answer starts a bound new turn', async ({
  page,
}, info) => {
  const directory = info.outputPath('timed-question');
  const caseHost = await workflowHost(
    directory,
    'timed',
    { 'pending-independent': [2, 8], 'late-authorized': [2, 8] },
    { rules: [askRule] },
  );
  try {
    const host = caseHost.current();
    const sessionId = await warmWorkflow(page, host);
    await sendWorkflow(
      page,
      'CW126-START：询问 sample 的局部许可；无答时只能做独立检查。',
    );
    const pending = await completedWorkflow(host, 'CW126-START');
    const question = workflowCall(pending, 'question');
    const timeout = workflowResult(pending, question.id);
    const pendingValue: unknown = JSON.parse(text(timeout.message['content']));
    expect(pendingValue).toMatchObject({ pending: true, callId: question.id });
    expect(pendingValue).not.toHaveProperty('answers');
    const independent = workflowCall(pending, 'pending-independent');
    const oldSnapshot = JSON.stringify(workflowSnapshot(host, independent.id));
    const before = await workflowWire(directory, independent.id);
    expect(
      prefixEvents(workflowSnapshot(host, independent.id)).filter(
        (event) => record(event['binding'])['status'] === 'bound',
      ),
    ).toHaveLength(0);
    expect(await executions(directory)).toEqual(['pending-independent']);
    const card = page.getByRole('radiogroup').first();
    await expect(card).toBeVisible();
    await card
      .getByRole('radio', { name: '允许 sample 文件', exact: true })
      .click();
    await page.getByRole('button', { name: '提交', exact: true }).click();
    const late = await waitForSession(
      host.home,
      (candidate) =>
        candidate.sessionId === sessionId &&
        candidate.events.filter((event) => event.type === 'turn/end').length >=
          3,
    );
    if (late === null) throw new Error('late bound answer did not resume');
    const answer = late.events.find(
      (event) =>
        event.type === 'user/message' &&
        record(record(event.data)['source'])['kind'] === 'user-question-reply',
    );
    expect(record(record(answer?.data)['source'])).toMatchObject({
      callId: question.id,
      outcome: 'answered',
    });
    const authorized = workflowCall(late, 'late-authorized');
    expect(authorized.event.seq).toBeGreaterThan(answer?.seq ?? -1);
    expect(record(authorized.event.data)['turn']).toBeGreaterThan(
      Number(record(question.event.data)['turn']),
    );
    const events = prefixEvents(workflowSnapshot(host, authorized.id));
    expect(events).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        binding: expect.objectContaining({
          askId: question.id,
          status: 'bound',
          answerIds: ['sample-only'],
        }),
      }),
    );
    const after = await workflowWire(directory, authorized.id);
    expect(after.text).toContain('允许 sample 文件');
    expect(after.text).toContain('sample-only');
    expect(JSON.stringify(workflowSnapshot(host, independent.id))).toBe(
      oldSnapshot,
    );
    expect(await workflowWire(directory, independent.id)).toEqual(before);
    expect(await executions(directory)).toEqual([
      'pending-independent',
      'late-authorized',
    ]);
    expect(await workflowWires(directory)).toHaveLength(2);
    await writeFile(
      join(directory, 'proof.json'),
      JSON.stringify(
        {
          sessionId,
          question: question.id,
          pending: timeout.event,
          lateAnswer: answer,
          continuation: authorized.id,
          priorSnapshotUnchanged: true,
        },
        null,
        2,
      ),
    );
  } finally {
    await captureWorkflow(caseHost, directory);
  }
});
