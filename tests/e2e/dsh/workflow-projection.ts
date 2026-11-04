/** Fresh production projections from actual durable host prefixes and receipts. */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readSessionLogs, type LoggedSession } from './session-log.ts';
import { record } from './workflow-fixture/protocol.ts';

export interface ProjectionInput {
  readonly home: string;
  readonly sessionId: string;
  readonly config: unknown;
  readonly snapshot: Record<string, unknown>;
}
async function compiled(path: string): Promise<Record<string, unknown>> {
  const value: unknown = await import(
    new URL(`../../../lib/${path}.js`, import.meta.url).href
  );
  return record(value);
}
function invoke(
  receiver: unknown,
  name: string,
  args: readonly unknown[],
): unknown {
  if (
    receiver === null ||
    (typeof receiver !== 'object' && typeof receiver !== 'function')
  )
    throw new Error('production receiver unavailable');
  const fn: unknown = Reflect.get(receiver, name);
  if (typeof fn !== 'function') throw new Error(`missing production ${name}`);
  return Reflect.apply(fn, receiver, args);
}
function nativeSession(native: LoggedSession, source: Record<string, unknown>) {
  const cutoff = record(record(source['status'])['cutoff'])['seq'];
  if (typeof cutoff !== 'number') throw new Error('no captured native cutoff');
  if (native.header?.['isSeeded'] !== false)
    throw new Error('this file adapter requires an unseeded native session');
  const events = native.events.filter(
    (event) => event.seq !== null && event.seq <= cutoff,
  );
  return {
    id: native.sessionId,
    header: native.header,
    seq: cutoff + 1,
    inheritedEventCount: 0,
    snapshotEvents: (from = 0, to = cutoff + 1) =>
      events.filter(
        (event) => (event.seq ?? -1) >= from && (event.seq ?? -1) < to,
      ),
    ownEvents: () => events,
  };
}
export async function projectNativePrefix(input: ProjectionInput) {
  const logs = await readSessionLogs(input.home);
  const native = logs.find((entry) => entry.sessionId === input.sessionId);
  if (native === undefined) throw new Error('actual durable session missing');
  const snapshot = input.snapshot;
  const prefix = record(snapshot['prefix']);
  const session = nativeSession(native, record(prefix['local']));
  const parentId = native.header?.['parentSession'];
  const nativeParent = logs.find((entry) => entry.sessionId === parentId);
  if (typeof parentId === 'string' && nativeParent === undefined)
    throw new Error('actual direct parent missing');
  const parent =
    nativeParent === undefined
      ? undefined
      : nativeSession(nativeParent, record(prefix['parent']));
  const sessions = {
    get: (id: string) => (id === parent?.id ? parent : undefined),
  };
  const auditModule = await compiled('audit');
  const config = record(input.config);
  const Constructor = auditModule['AuditStore'];
  if (typeof Constructor !== 'function')
    throw new Error('no production AuditStore');
  const path = invoke(auditModule, 'resolveAuditPath', [input.home]);
  const audit: unknown = Reflect.construct(Constructor, [
    path,
    config['audit'],
  ]);
  try {
    const workflow = invoke(
      await compiled('snapshot/workflow'),
      'workflowRedactor',
      [session, sessions],
    );
    const redaction = await compiled('snapshot/source-redaction');
    const toolResults = {
      discover: (log: unknown) =>
        invoke(redaction, 'discoverLog', [log, workflow]),
      read: (receipt: unknown) => {
        const item = record(receipt);
        return invoke(audit, 'getToolResult', [
          item['sessionId'],
          item['callId'],
          receipt,
        ]);
      },
    };
    const action = record(snapshot['action']);
    const prepared = await invoke(
      await compiled('snapshot'),
      'prepareReviewSnapshot',
      [
        {
          agent: { session },
          sessions,
          toolResults,
          tool: snapshot['tool'],
          arguments: action['arguments'],
          callId: snapshot['callId'],
          cwd: snapshot['cwd'],
          config: input.config,
          facts: snapshot['facts'],
          turn: snapshot['turn'],
          priorVerdicts: snapshot['priorVerdicts'],
          historyStatus: snapshot['historyStatus'],
          sessionRecordGap: null,
          configRevision: snapshot['configRevision'],
        },
        workflow,
      ],
    );
    const bundle = record(record(prepared)['bundle']);
    const projected = record(bundle['snapshot']);
    if (projected['callId'] !== snapshot['callId'])
      throw new Error('projection identity changed');
    // This is the only non-source field that a new construction creates anew.
    return { ...bundle, snapshot: { ...projected, createdAt: 0 } };
  } finally {
    invoke(audit, 'close', []);
  }
}

export async function coldNativePrefix(input: ProjectionInput, output: string) {
  const inputPath = output + '.input.json';
  await writeFile(inputPath, JSON.stringify(input));
  await promisify(execFile)(
    process.execPath,
    [fileURLToPath(import.meta.url), inputPath, output],
    { env: process.env },
  );
  const value: unknown = JSON.parse(await readFile(output, 'utf8'));
  return record(value);
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const source = process.argv[2];
  const output = process.argv[3];
  if (source === undefined || output === undefined)
    throw new Error('projection input/output required');
  const raw = record(JSON.parse(await readFile(source, 'utf8')));
  const home = raw['home'];
  const sessionId = raw['sessionId'];
  if (typeof home !== 'string' || typeof sessionId !== 'string')
    throw new Error('invalid projection identity');
  const projected = await projectNativePrefix({
    home,
    sessionId,
    config: raw['config'],
    snapshot: record(raw['snapshot']),
  });
  await writeFile(output, JSON.stringify(projected, null, 2));
}
