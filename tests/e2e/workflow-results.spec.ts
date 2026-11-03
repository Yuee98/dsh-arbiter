import { execFile } from 'node:child_process';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, test } from '@playwright/test';
import { resolveAuditPath } from '../../src/audit.js';
import { toolResultDirectory } from '../../src/audit/tool-result-files.js';
import {
  allowedTool,
  captureWorkflow,
  completedWorkflow,
  executions,
  openWorkflow,
  prefixEvents,
  readAudit,
  record,
  sendWorkflow,
  warmWorkflow,
  workflowCall,
  workflowHost,
  workflowResult,
  workflowSnapshot,
  workflowWire,
  workflowWires,
} from './dsh/workflow-host.js';
import { projectNativePrefix } from './dsh/workflow-projection.js';
import { waitForSession } from './dsh/session-log.js';

const execFileAsync = promisify(execFile);
test('actual late and failed results drive repair, immutable wires and fresh hot/cold projections', async ({
  page,
}, info) => {
  test.setTimeout(240000);
  const directory = info.outputPath('continuous-results');
  const caseHost = await workflowHost(
    directory,
    'continuity',
    { before: [2, 8], after: [2, 8], failure: [2, 8], repair: [2, 8] },
    { rules: [allowedTool('slow-query', 'workflow_probe', '$.stage', 'slow')] },
  );
  try {
    let host = caseHost.current();
    const sessionId = await warmWorkflow(page, host);
    const marker = await readFile(join(directory, 'result-marker.txt'), 'utf8');
    const long = `${marker}\n${Array.from({ length: 7000 }, (_, index) => `CW126_ROW ${String(index).padStart(6, '0')} local-only result`).join('\n')}\nCW126_RESULT_TAIL`;
    await writeFile(join(directory, 'long-source.txt'), long);
    await sendWorkflow(
      page,
      'CW126-START：查询结果，再检查，再修复一次真实失败。',
    );
    await expect
      .poll(async () =>
        (await workflowWires(directory)).map((wire) => wire['stage']),
      )
      .toContain('before');
    await expect
      .poll(async () =>
        readFile(join(directory, 'slow-started'), 'utf8').catch(() => ''),
      )
      .toBe('started');
    const beforeWireRecord = (await workflowWires(directory)).find(
      (wire) => wire['stage'] === 'before',
    );
    const beforeId = record(beforeWireRecord)['callId'];
    if (typeof beforeId !== 'string') throw new Error('no before review');
    await expect
      .poll(() => readAudit(host, (audit) => audit.getCall(beforeId)) !== null)
      .toBe(true);
    const before = workflowSnapshot(host, beforeId);
    const immutable = JSON.stringify(before);
    const beforeWire = await workflowWire(directory, beforeId);
    const inFlight = await waitForSession(
      host.home,
      (session) =>
        session.sessionId === sessionId &&
        session.events.some(
          (event) =>
            event.type === 'tool/call' &&
            String(record(event.data)['callId']).startsWith('cw126-slow-'),
        ),
    );
    if (inFlight === null) throw new Error('slow call was never dispatched');
    const slow = workflowCall(inFlight, 'slow');
    expect(prefixEvents(before)).toContainEqual(
      expect.objectContaining({ kind: 'call', callId: slow.id }),
    );
    expect(
      prefixEvents(before).filter(
        (event) => event['kind'] === 'result' && event['callId'] === slow.id,
      ),
    ).toHaveLength(0);
    expect(
      readAudit(host, (audit) => audit.getToolResult(sessionId, slow.id)).state,
    ).toBe('absent');
    expect(beforeWire.text).not.toContain(marker);
    expect(beforeWire.text).not.toContain('CW126_RESULT_TAIL');
    await writeFile(join(directory, 'slow-release'), 'release');
    const session = await completedWorkflow(host, 'CW126-START');
    const after = workflowCall(session, 'after');
    const failure = workflowCall(session, 'failure');
    const repair = workflowCall(session, 'repair');
    const slowResult = workflowResult(session, slow.id);
    expect(slowResult.event.seq).toBeGreaterThan(slow.event.seq ?? -1);
    expect(slowResult.event.seq).toBeLessThan(after.event.seq ?? -1);
    expect(workflowResult(session, failure.id).message['isError']).toBe(true);
    expect(workflowResult(session, repair.id).message['isError']).toBe(false);
    expect(repair.event.seq).toBeGreaterThan(
      workflowResult(session, failure.id).event.seq ?? -1,
    );
    const afterSnapshot = workflowSnapshot(host, after.id);
    const afterEvents = prefixEvents(afterSnapshot);
    const returned = afterEvents.find(
      (event) => event['kind'] === 'result' && event['callId'] === slow.id,
    );
    expect(returned).toMatchObject({
      status: 'success',
      body: { state: 'present' },
      collection: { save: 'saved', content: 'available', read: 'found' },
    });
    expect(afterEvents.some((event) => event['callId'] === after.id)).toBe(
      false,
    );
    const afterWire = await workflowWire(directory, after.id);
    expect(afterWire.text).toContain(slow.id);
    expect(afterWire.text).toContain(marker);
    expect(afterWire.text).toContain('CW126_RESULT_TAIL');
    expect(afterWire.text).not.toContain(long);
    expect(record(afterSnapshot['budget'])).toMatchObject({
      targetInputTokens: 6000,
      maxInputTokens: 10000,
    });
    const units = record(afterSnapshot['budget'])['units'];
    expect(units).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: expect.stringContaining(slow.id),
          cap: 600,
          truncated: true,
        }),
      ]),
    );
    const stored = readAudit(host, (audit) =>
      audit.getToolResult(sessionId, slow.id),
    );
    expect(stored).toMatchObject({
      state: 'found',
      storage: 'file',
      metadata: {
        status: 'success',
        contentState: 'available',
        localTruncation: null,
      },
    });
    expect(stored.metadata?.sourceBytes).toBeGreaterThan(65536);
    const retained = stored.fragments.map((part) => part.text).join('');
    await writeFile(
      join(directory, 'stored-result.json'),
      JSON.stringify(stored, null, 2),
    );
    expect(retained).toContain(marker);
    expect(retained).toContain('CW126_RESULT_TAIL');
    const valuePart = stored.metadata?.parts.find(
      (part) => part.channel === 'value' && part.kind === 'json',
    );
    expect(valuePart).toBeDefined();
    if (valuePart === undefined)
      throw new Error('original structured value was not retained');
    const originalValue: unknown = JSON.parse(
      Buffer.from(retained)
        .subarray(valuePart.start, valuePart.start + valuePart.bytes)
        .toString('utf8'),
    );
    expect(originalValue).toBe(long);
    expect(JSON.stringify(slowResult.message['content'])).toContain('Omitted');
    expect(retained.length).toBeGreaterThan(
      JSON.stringify(record(returned?.['body'])['content']).length,
    );
    expect(
      JSON.stringify(record(returned?.['body'])['content']).length,
    ).toBeLessThan(stored.metadata?.sourceBytes ?? 0);
    const repairSnapshot = workflowSnapshot(host, repair.id);
    expect(prefixEvents(repairSnapshot)).toContainEqual(
      expect.objectContaining({
        kind: 'result',
        callId: failure.id,
        status: 'failure',
      }),
    );
    expect((await workflowWire(directory, repair.id)).text).toContain(
      'CW126 controlled actual failure',
    );
    expect(JSON.stringify(workflowSnapshot(host, beforeId))).toBe(immutable);
    expect(await workflowWire(directory, beforeId)).toEqual(beforeWire);
    const executed = await executions(directory);
    expect([...executed.slice(0, 2)].sort()).toEqual(['before', 'slow']);
    expect(executed.slice(2)).toEqual(['after', 'failure', 'repair']);
    expect(await workflowWires(directory)).toHaveLength(4);

    const response = await page.request.get(`${host.origin}/api/arbiter/state`);
    expect(response.status()).toBe(200);
    const config = record(await response.json())['config'];
    const input = {
      home: host.home,
      sessionId,
      config,
      snapshot: repairSnapshot,
    };
    const hot = await projectNativePrefix(input);
    expect(record(hot['snapshot'])['prefix']).toEqual(repairSnapshot['prefix']);
    await writeFile(
      join(directory, 'hot-projection.json'),
      JSON.stringify(hot, null, 2),
    );
    // A real CLI restart keeps the original profile, native sources and receipts.
    host = await caseHost.restart();
    await openWorkflow(page, host);
    expect(
      (await page.request.get(`${host.origin}/api/arbiter/state`)).status(),
    ).toBe(200);
    expect(
      readAudit(host, (audit) =>
        audit.getToolResult(sessionId, slow.id, stored.receipt ?? undefined),
      ),
    ).toEqual(stored);
    await host.stop({ keepHome: true });
    const inputPath = join(directory, 'projection-input.json');
    const outputPath = join(directory, 'cold-projection.json');
    await writeFile(inputPath, JSON.stringify(input));
    await execFileAsync(
      process.execPath,
      [
        fileURLToPath(new URL('./dsh/workflow-projection.ts', import.meta.url)),
        inputPath,
        outputPath,
      ],
      { env: process.env },
    );
    const cold: unknown = JSON.parse(await readFile(outputPath, 'utf8'));
    expect(cold).toEqual(hot);
    const coldSlow = prefixEvents(record(record(cold)['snapshot'])).find(
      (event) => event['kind'] === 'result' && event['callId'] === slow.id,
    );
    expect(coldSlow).toMatchObject({
      body: { state: 'present' },
      collection: { read: 'found' },
    });
    expect(stored.fileRef).toMatch(/^[a-f0-9-]+\.body$/u);
    if (stored.fileRef === null)
      throw new Error('long result has no owned body file');
    await rm(
      join(toolResultDirectory(resolveAuditPath(host.home)), stored.fileRef),
    );
    const lost = await projectNativePrefix(input);
    const missing = prefixEvents(record(lost['snapshot'])).find(
      (event) => event['kind'] === 'result' && event['callId'] === slow.id,
    );
    expect(missing).toMatchObject({
      status: 'success',
      body: { state: 'unavailable', reason: 'lost' },
      collection: { read: 'missing-file' },
    });
    expect(missing?.['eventId']).toBe(coldSlow?.['eventId']);
    expect(missing?.['seq']).toBe(coldSlow?.['seq']);
    await writeFile(
      join(directory, 'source-loss-projection.json'),
      JSON.stringify(lost, null, 2),
    );
    expect(JSON.stringify(workflowSnapshot(host, beforeId))).toBe(immutable);
    await writeFile(
      join(directory, 'proof.json'),
      JSON.stringify(
        {
          sessionId,
          before: beforeId,
          slow: slow.id,
          after: after.id,
          failure: failure.id,
          repair: repair.id,
          nativeResultSeq: slowResult.event.seq,
          stored: stored.metadata,
          sourceUnchangedHotColdEqual: true,
          normalization: ['snapshot.createdAt'],
          missingSource: missing,
          executions: await executions(directory),
        },
        null,
        2,
      ),
    );
  } finally {
    await writeFile(join(directory, 'slow-release'), 'release');
    await captureWorkflow(caseHost, directory);
  }
});
