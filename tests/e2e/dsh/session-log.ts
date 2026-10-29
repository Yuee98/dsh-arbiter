import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/**
 * Read the isolated host's durable session log.
 *
 * The log — not the plugin's memory, the audit database or the UI — is the
 * authority for what the host committed: plugin admission records, permission
 * events, `/permission` command pairs, tool calls and their results.
 *
 * DSH writes one zstd frame per flush into `session.v4.jsonl.zstd`, so the
 * reader splits on the frame magic before decompressing.
 */

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

export interface LoggedEvent {
  /** Absent on the creation header (`type: "session"`), which has no seq. */
  readonly seq: number | null;
  readonly type: string;
  readonly data?: unknown;
  readonly ignorable?: boolean;
  readonly time?: number;
}

export interface LoggedSession {
  readonly sessionId: string;
  readonly header: Record<string, unknown> | null;
  readonly events: readonly LoggedEvent[];
}

/** Validate one decoded line as a committed session event. */
function isLoggedEvent(value: unknown): value is LoggedEvent {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return false;
  if (typeof Reflect.get(value, 'type') !== 'string') return false;
  const seq: unknown = Reflect.get(value, 'seq');
  // The creation header has no seq; every committed event does.
  if (seq !== undefined && typeof seq !== 'number') return false;
  return true;
}

/** The raw header object without the reader's own placeholder field. */
function withoutSeq(event: LoggedEvent): Record<string, unknown> {
  const raw: unknown = event;
  if (raw === null || typeof raw !== 'object') return {};
  return { ...raw };
}

/** Narrow one event's `data` to a read-only record without asserting. */
function dataOf(event: LoggedEvent): Readonly<Record<string, unknown>> | null {
  const data: unknown = event.data;
  if (data === null || typeof data !== 'object' || Array.isArray(data))
    return null;
  return { ...data };
}

/** Decode every zstd frame in one file into its JSON lines. */
export function decodeSessionLog(buffer: Buffer): LoggedEvent[] {
  const starts: number[] = [];
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer.compare(ZSTD_MAGIC, 0, 4, index, index + 4) === 0)
      starts.push(index);
  }
  const events: LoggedEvent[] = [];
  for (let frame = 0; frame < starts.length; frame += 1) {
    const start = starts[frame] ?? 0;
    const end = starts[frame + 1] ?? buffer.length;
    let text: string;
    try {
      text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    } catch {
      // A torn tail is not evidence of anything; skip that frame only.
      continue;
    }
    for (const line of text.split('\n')) {
      if (line.trim().length === 0) continue;
      try {
        const value: unknown = JSON.parse(line);
        if (isLoggedEvent(value)) events.push(value);
      } catch {
        // Skip a partial line rather than failing the whole read.
      }
    }
  }
  return events;
}

/** Every session log under one isolated home, in directory order. */
export async function readSessionLogs(home: string): Promise<LoggedSession[]> {
  const root = join(home, 'sessions');
  const sessions: LoggedSession[] = [];
  const workspaces = await readdir(root).catch(() => [] as string[]);
  for (const workspace of workspaces) {
    const ids = await readdir(join(root, workspace)).catch(
      () => [] as string[],
    );
    for (const id of ids) {
      const directory = join(root, workspace, id);
      const files = await readdir(directory).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.startsWith('session.') || !file.includes('jsonl')) continue;
        // The host writes a log by creating a temporary sibling and renaming it
        // into place, so a poll can observe `session.*.jsonl.<hash>.tmp` between
        // those two steps. That file is a write in progress, not a log: reading it
        // races the rename and fails with ENOENT, or decodes a truncated body. The
        // next poll sees the finished file, so skipping it loses nothing.
        if (file.endsWith('.tmp')) continue;
        // The same race in its other form: the file this listing named has been
        // renamed away by the time it is opened. A session that vanished between
        // listing and reading is simply not observable this poll.
        const body = await readFile(join(directory, file)).catch(() => null);
        if (body === null) continue;
        const events = decodeSessionLog(body);
        // The creation header carries the durable lineage: `parentSession`,
        // `origin` and `delegationDepth` are what scope a subagent.
        const header = events.find((event) => event.type === 'session');
        const headerData =
          header === undefined
            ? null
            : { ...(typeof header === 'object' ? withoutSeq(header) : {}) };
        sessions.push({
          sessionId: id,
          header: headerData,
          events: events.filter((event) => event.type !== 'session'),
        });
      }
    }
  }
  return sessions;
}

/** Poll until `predicate` holds for some session, or the deadline passes. */
export async function waitForSession(
  home: string,
  predicate: (session: LoggedSession) => boolean,
  timeoutMs = 60_000,
): Promise<LoggedSession | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await readSessionLogs(home)).find(predicate);
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

/** The latest value of each permission knob, as the log folds them. */
export function effectivePermission(events: readonly LoggedEvent[]): {
  readonly preset: string | null;
  readonly sandbox: string | null;
  readonly approval: string | null;
} {
  let preset: string | null = null;
  let sandbox: string | null = null;
  let approval: string | null = null;
  for (const event of events) {
    const data: unknown = event.data;
    if (typeof data !== 'object' || data === null) continue;
    const record: Readonly<Record<string, unknown>> = { ...data };
    if (
      event.type === 'permission/preset' &&
      typeof record['preset'] === 'string'
    )
      preset = record['preset'];
    if (event.type === 'sandbox/mode' && typeof record['mode'] === 'string')
      sandbox = record['mode'];
    if (
      event.type === 'approval/policy' &&
      typeof record['policy'] === 'string'
    )
      approval = record['policy'];
  }
  return { preset, sandbox, approval };
}

/** The last admission record the plugin wrote for this session. */
export function lastAdmission(
  events: readonly LoggedEvent[],
): Record<string, unknown> | null {
  let latest: Record<string, unknown> | null = null;
  for (const event of events) {
    if (event.type !== 'plugin:arbiter/admission') continue;
    const data = dataOf(event);
    if (data !== null) latest = data;
  }
  return latest;
}

/** Every `/permission` command with its recorded settlement. */
export function permissionCommands(events: readonly LoggedEvent[]): readonly {
  readonly args: string;
  readonly settled: 'success' | 'error' | null;
}[] {
  const runs = new Map<
    string,
    { args: string; settled: 'success' | 'error' | null }
  >();
  for (const event of events) {
    const record = dataOf(event);
    if (record === null) continue;
    const id = record['commandId'];
    if (typeof id !== 'string') continue;
    if (event.type === 'command/run' && record['name'] === 'permission') {
      runs.set(id, {
        args: typeof record['args'] === 'string' ? record['args'] : '',
        settled: null,
      });
    }
    if (event.type === 'command/done') {
      const run = runs.get(id);
      if (run === undefined) continue;
      runs.set(id, {
        args: run.args,
        settled: record['kind'] === 'success' ? 'success' : 'error',
      });
    }
  }
  return [...runs.values()];
}
