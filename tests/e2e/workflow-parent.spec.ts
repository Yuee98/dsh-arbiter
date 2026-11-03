import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { startNewSession } from './dsh/ui.js';
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
  workflowSnapshot,
  workflowWire,
  workflowWires,
} from './dsh/workflow-host.js';
import { waitForSession } from './dsh/session-log.js';
import {
  projectNativePrefix,
  coldNativePrefix,
} from './dsh/workflow-projection.js';

test('a live child observes original parent restriction, a local exception and its withdrawal', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const directory = info.outputPath('parent-refresh');
  const caseHost = await workflowHost(
    directory,
    'parent',
    { 'child-1': [5, 1], 'child-2': [2, 8], 'child-3': [5, 1] },
    {
      rules: [
        allowedTool(
          'real-delegation',
          'subagent',
          '$.description',
          '受控子任务',
        ),
      ],
    },
  );
  try {
    const host = caseHost.current();
    const rootId = await warmWorkflow(page, host);
    await sendWorkflow(
      page,
      'CW126-START CW126-RESTRICTION：禁止交付 sample.txt 和 full.txt，转交子任务也不能扩大范围。',
    );
    await completedWorkflow(host, 'CW126-START');
    await expect
      .poll(async () =>
        readFile(join(directory, 'child-2-waiting'), 'utf8').catch(() => ''),
      )
      .toBe('waiting');
    const child = await waitForSession(
      host.home,
      (session) =>
        session.header?.['parentSession'] === rootId &&
        session.events.some(
          (event) =>
            event.type === 'tool/call' &&
            String(record(event.data)['callId']).startsWith('cw126-child-1-'),
        ),
    );
    if (child === null)
      throw new Error('real managed child did not reach its first call');
    const c1 = workflowCall(child, 'child-1');
    expect(workflowDecision(child, c1.id)).toMatchObject([
      { result: 'review-deny' },
    ]);
    const first = workflowSnapshot(host, c1.id);
    const frozen = JSON.stringify(first);
    const firstWire = await workflowWire(directory, c1.id);
    expect(prefixEvents(first, 'parent')).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        source: 'parent-human',
        sessionId: rootId,
        text: expect.stringContaining('CW126-RESTRICTION'),
      }),
    );
    expect(prefixEvents(first)).toContainEqual(
      expect.objectContaining({
        kind: 'relay',
        protected: false,
        source: 'parent-relay',
        senderSessionId: rootId,
        text: expect.stringContaining('CW126-CHILD'),
      }),
    );
    // An unrelated session exists in the very same live host; it must stay out.
    const siblingId = await startNewSession(page);
    await sendWorkflow(
      page,
      'CW126-SIBLING：这个会话的授权不能提供给其他任务。',
    );
    const sibling = await completedWorkflow(host, 'CW126-SIBLING');
    expect(sibling.sessionId).toBe(siblingId);
    expect(siblingId).not.toBe(rootId);
    const parentItem = page
      .getByRole('treeitem', { name: /CW126-WARM/u })
      .first();
    await parentItem.click();
    await expect(parentItem).toHaveAttribute('aria-selected', 'true');
    await sendWorkflow(
      page,
      'CW126-EXCEPTION：仅本次允许 sample.txt，full.txt 仍然禁止。',
    );
    const updated = await completedWorkflow(host, 'CW126-EXCEPTION');
    expect(updated.sessionId).toBe(rootId);
    await writeFile(join(directory, 'child-2-release'), 'release');
    await expect
      .poll(async () =>
        readFile(join(directory, 'child-3-waiting'), 'utf8').catch(() => ''),
      )
      .toBe('waiting');
    const secondChild = await waitForSession(
      host.home,
      (session) =>
        session.sessionId === child.sessionId &&
        session.events.some(
          (event) =>
            event.type === 'tool/result' &&
            String(
              record(record(event.data)['message'])['toolCallId'],
            ).startsWith('cw126-child-2-'),
        ),
    );
    if (secondChild === null)
      throw new Error('child did not continue after parent exception');
    const c2 = workflowCall(secondChild, 'child-2');
    const second = workflowSnapshot(host, c2.id);
    const secondFrozen = JSON.stringify(second);
    expect(prefixEvents(second, 'parent')).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        source: 'parent-human',
        text: expect.stringContaining('CW126-EXCEPTION'),
      }),
    );
    expect(JSON.stringify(second)).not.toContain('CW126-SIBLING');
    expect(workflowDecision(secondChild, c2.id)).toMatchObject([
      { result: 'review-allow' },
    ]);
    expect(await executions(directory)).toEqual(['child-2']);
    await sendWorkflow(
      page,
      'CW126-WITHDRAWAL：撤回刚才 sample.txt 的局部例外，恢复原限制。',
    );
    const withdrawal = await completedWorkflow(host, 'CW126-WITHDRAWAL');
    expect(withdrawal.sessionId).toBe(rootId);
    await writeFile(join(directory, 'child-3-release'), 'release');
    const finished = await waitForSession(
      host.home,
      (session) =>
        session.sessionId === child.sessionId &&
        session.events.some((event) => event.type === 'turn/end'),
    );
    if (finished === null)
      throw new Error('child never settled after withdrawal');
    const c3 = workflowCall(finished, 'child-3');
    const third = workflowSnapshot(host, c3.id);
    expect(workflowDecision(finished, c3.id)).toMatchObject([
      { result: 'review-deny' },
    ]);
    expect(prefixEvents(third, 'parent')).toContainEqual(
      expect.objectContaining({
        kind: 'human',
        source: 'parent-human',
        text: expect.stringContaining('CW126-WITHDRAWAL'),
      }),
    );
    const cutoff = (snapshot: Record<string, unknown>) =>
      Number(
        record(
          record(record(record(snapshot['prefix'])['parent'])['status'])[
            'cutoff'
          ],
        )['seq'],
      );
    expect(cutoff(second)).toBeGreaterThan(cutoff(first));
    expect(cutoff(third)).toBeGreaterThan(cutoff(second));
    const secondWire = await workflowWire(directory, c2.id);
    const thirdWire = await workflowWire(directory, c3.id);
    for (const snapshot of [first, second, third]) {
      const parentEvents = prefixEvents(snapshot, 'parent');
      expect(
        parentEvents.every(
          (event) =>
            event['sessionId'] === rootId &&
            ['human', 'question'].includes(String(event['kind'])),
        ),
      ).toBe(true);
      expect(parentEvents).toContainEqual(
        expect.objectContaining({
          kind: 'human',
          text: expect.stringContaining('CW126-RESTRICTION'),
        }),
      );
    }
    expect(firstWire.text).not.toContain('CW126-EXCEPTION');
    expect(secondWire.text).toContain('CW126-EXCEPTION');
    expect(secondWire.text).not.toContain('CW126-WITHDRAWAL');
    expect(thirdWire.text).toContain('CW126-WITHDRAWAL');
    for (const wire of [firstWire, secondWire, thirdWire])
      expect(wire.text).not.toContain('CW126-SIBLING');
    expect(JSON.stringify(workflowSnapshot(host, c1.id))).toBe(frozen);
    expect(JSON.stringify(workflowSnapshot(host, c2.id))).toBe(secondFrozen);
    expect(await workflowWire(directory, c1.id)).toEqual(firstWire);
    expect(await executions(directory)).toEqual(['child-2']);
    for (const stage of ['child-1', 'child-3'])
      await expect(
        readFile(join(directory, `${stage}-effect.txt`)),
      ).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await workflowWires(directory)).toHaveLength(3);
    const response = await page.request.get(`${host.origin}/api/arbiter/state`);
    expect(response.status()).toBe(200);
    const config = record(await response.json())['config'];
    const input = {
      home: host.home,
      sessionId: child.sessionId,
      config,
      snapshot: third,
    };
    const hot = await projectNativePrefix(input);
    expect(record(hot['snapshot'])['prefix']).toEqual(third['prefix']);
    const cold = await coldNativePrefix(
      input,
      join(directory, 'cold-child-projection.json'),
    );
    expect(cold).toEqual(hot);
    await writeFile(
      join(directory, 'proof.json'),
      JSON.stringify(
        {
          driver: 'real browser parent messages + real managed subagent',
          rootId,
          childId: child.sessionId,
          siblingId,
          calls: [c1.id, c2.id, c3.id],
          cutoffs: [cutoff(first), cutoff(second), cutoff(third)],
          executions: await executions(directory),
          earlierViewsUnchanged: true,
          freshChildAndParentHotColdEqual: true,
          normalization: ['snapshot.createdAt'],
        },
        null,
        2,
      ),
    );
  } finally {
    await Promise.all(
      ['child-2', 'child-3'].map((stage) =>
        writeFile(join(directory, `${stage}-release`), 'release'),
      ),
    );
    await captureWorkflow(caseHost, directory);
  }
});
