/**
 * Read an isolated run's durable session log.
 *
 * The log is the authority for "what actually happened to permissions": it is
 * appended by the host itself, so it shows `command/run` (before a handler),
 * `permission/preset` / `sandbox/mode` / `approval/policy`, `command/done`,
 * and the arbiter decision records with their `ignorable` marker.
 */
import { readFile } from 'node:fs/promises';
import { zstdDecompressSync } from 'node:zlib';
import { sessionLogs } from './env.mjs';

const MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Decode every zstd frame in the file and return its JSON events. */
export function decodeLog(buffer) {
  const starts = [];
  for (let i = 0; i + 4 <= buffer.length; i += 1) {
    if (buffer.compare(MAGIC, 0, 4, i, i + 4) === 0) starts.push(i);
  }
  const events = [];
  for (let k = 0; k < starts.length; k += 1) {
    const start = starts[k];
    const end = starts[k + 1] ?? buffer.length;
    const text = zstdDecompressSync(buffer.subarray(start, end)).toString('utf8');
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try { events.push(JSON.parse(line)); } catch { /* skip torn tail */ }
    }
  }
  return events;
}

/** Read every session log in an isolated home, newest last. */
export async function readSessions(home) {
  const out = [];
  for (const entry of await sessionLogs(home)) {
    const events = decodeLog(await readFile(entry.path));
    out.push({
      sessionId: entry.sessionId,
      path: entry.path,
      header: events.find((e) => e.type === 'session') ?? null,
      events: events.filter((e) => e.type !== 'session'),
    });
  }
  return out;
}

/** Fold the permission-relevant events for one session. */
export function permissionTimeline(events) {
  const out = [];
  for (const event of events) {
    if (!['command/run', 'command/done', 'permission/preset', 'sandbox/mode', 'approval/policy', 'plugin:arbiter/decision'].includes(event.type)) continue;
    out.push({
      seq: event.seq,
      type: event.type,
      ignorable: event.ignorable === true,
      data: event.data ?? null,
    });
  }
  return out;
}

/** Effective sandbox/approval after the last knob event. */
export function effectivePermission(events) {
  let preset = null;
  let sandbox = null;
  let approval = null;
  for (const event of events) {
    if (event.type === 'permission/preset') preset = event.data?.preset ?? null;
    if (event.type === 'sandbox/mode') sandbox = event.data?.mode ?? null;
    if (event.type === 'approval/policy') approval = event.data?.policy ?? null;
  }
  return { preset, sandbox, approval };
}

/** Every `/permission` command the user submitted, with its settlement. */
export function permissionCommands(events) {
  const runs = new Map();
  for (const event of events) {
    if (event.type === 'command/run' && event.data?.name === 'permission') {
      runs.set(event.data.commandId, {
        seq: event.seq,
        args: String(event.data.args ?? ''),
        done: null,
      });
    }
    if (event.type === 'command/done') {
      const entry = runs.get(event.data?.commandId);
      if (entry !== undefined) {
        entry.done = { seq: event.seq, kind: event.data.kind, text: event.data.text ?? null };
      }
    }
  }
  return [...runs.values()];
}
