/**
 * Point repair for session logs written by older arbiter builds.
 *
 * Older builds appended decision records with `session.append(...)`, which
 * omits the envelope's `ignorable` marker. The host's cold reader refuses a
 * log containing a type it does not know unless that marker is present, so
 * such a session can no longer be opened at all.
 *
 * The repair is deliberately narrow:
 *   - it writes a byte-identical backup next to the log before touching it;
 *   - it only rewrites `plugin:arbiter/*` events that lack `ignorable`;
 *   - every other event, and every untouched frame, keeps its original bytes;
 *   - it never deletes a session and never relaxes the reader's unknown-type
 *     check for anything else;
 *   - it is idempotent, and reports exactly what it changed.
 *
 * It is not run automatically. An operator invokes it explicitly for a session
 * that fails to load, and can restore the backup to undo it.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
/** Only this plugin's own records are repaired. */
const ARBITER_RECORD = /^plugin:arbiter\/[a-z0-9][a-z0-9._-]*$/u;

export interface RepairEvent {
  readonly type?: string;
  readonly seq?: number;
  readonly ignorable?: boolean;
  readonly [key: string]: unknown;
}

/** Narrow parsed JSON to an event envelope we can inspect. */
function asEvent(value: unknown): (RepairEvent & { type: string }) | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return undefined;
  const record: Record<string, unknown> = { ...value };
  return typeof record['type'] === 'string'
    ? { ...record, type: record['type'] }
    : undefined;
}

export interface RepairFinding {
  readonly seq: number;
  readonly type: string;
}

export interface InspectionResult {
  readonly path: string;
  readonly frames: number;
  readonly events: number;
  /** Arbiter records missing the marker: these are the repair target. */
  readonly repairable: readonly RepairFinding[];
  /** Arbiter records that already carry the marker. */
  readonly alreadyIgnorable: readonly RepairFinding[];
  /** Other `plugin:` records missing the marker: reported, never rewritten. */
  readonly foreignNonIgnorable: readonly RepairFinding[];
}

export interface RepairResult extends InspectionResult {
  readonly backupPath: string | null;
  readonly rewritten: readonly RepairFinding[];
  readonly untouchedEvents: number;
  readonly changed: boolean;
  readonly backupSha256: string | null;
  readonly repairedSha256: string | null;
}

/**
 * Split a zstd file into its frames.
 *
 * Session logs are appended frame by frame, and `node:zlib` decodes one frame
 * per call, so the buffer is split on the zstd magic number.
 */
function splitFrames(buffer: Buffer): Buffer[] {
  const starts: number[] = [];
  for (let index = 0; index + ZSTD_MAGIC.length <= buffer.length; index += 1) {
    if (
      buffer.compare(
        ZSTD_MAGIC,
        0,
        ZSTD_MAGIC.length,
        index,
        index + ZSTD_MAGIC.length,
      ) === 0
    ) {
      starts.push(index);
    }
  }
  if (starts.length === 0) throw new Error('the file contains no zstd frame');
  return starts.map((start, index) =>
    buffer.subarray(start, starts[index + 1] ?? buffer.length),
  );
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * Read a session log and report what a repair would change. Writes nothing.
 *
 * @param path - the `session.v*.jsonl.zstd` file.
 */
export function inspectSessionLog(path: string): InspectionResult {
  const frames = splitFrames(readFileSync(path));
  const repairable: RepairFinding[] = [];
  const alreadyIgnorable: RepairFinding[] = [];
  const foreignNonIgnorable: RepairFinding[] = [];
  let events = 0;
  for (const frame of frames) {
    for (const line of zstdDecompressSync(frame).toString('utf8').split('\n')) {
      if (line.trim() === '') continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      const event = asEvent(parsed);
      if (event === undefined || typeof event.seq !== 'number') continue;
      events += 1;
      const finding = { seq: event.seq, type: event.type };
      if (ARBITER_RECORD.test(event.type)) {
        if (event.ignorable === true) alreadyIgnorable.push(finding);
        else repairable.push(finding);
      } else if (event.type.startsWith('plugin:') && event.ignorable !== true) {
        foreignNonIgnorable.push(finding);
      }
    }
  }
  return {
    path,
    frames: frames.length,
    events,
    repairable,
    alreadyIgnorable,
    foreignNonIgnorable,
  };
}

/**
 * Repair one session log in place, after writing a backup.
 *
 * @param path - the `session.v*.jsonl.zstd` file to repair.
 * @param options.dryRun - report the planned change without writing anything.
 * @returns what was changed, with the backup path and both hashes.
 */
export function repairSessionLog(
  path: string,
  options: { readonly dryRun?: boolean } = {},
): RepairResult {
  const inspection = inspectSessionLog(path);
  const original = readFileSync(path);
  const frames = splitFrames(original);
  const rewritten: RepairFinding[] = [];
  let untouchedEvents = 0;

  const rebuilt = frames.map((frame) => {
    const text = zstdDecompressSync(frame).toString('utf8');
    // Count rewrites per frame instead of a mutated flag: control-flow
    // analysis would otherwise narrow the flag to its initial value.
    const before = rewritten.length;
    const lines = text.split('\n').map((line) => {
      if (line.trim() === '') return line;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        untouchedEvents += 1;
        return line;
      }
      const event = asEvent(parsed);
      if (
        event === undefined ||
        !ARBITER_RECORD.test(event.type) ||
        event.ignorable === true
      ) {
        untouchedEvents += 1;
        return line;
      }
      rewritten.push({
        seq: typeof event.seq === 'number' ? event.seq : -1,
        type: event.type,
      });
      // Preserve key order and every value; add only the missing marker.
      return JSON.stringify({ ...event, ignorable: true });
    });
    return rewritten.length > before
      ? zstdCompressSync(Buffer.from(lines.join('\n'), 'utf8'))
      : frame;
  });

  if (rewritten.length === 0 || options.dryRun) {
    return {
      ...inspection,
      backupPath: null,
      rewritten,
      untouchedEvents,
      changed: false,
      backupSha256: null,
      repairedSha256: null,
    };
  }

  const backupPath = `${path}.arbiter-backup`;
  copyFileSync(path, backupPath);
  const backupSha256 = sha256(readFileSync(backupPath));

  // Rebuild through a sibling temp file so an interrupted write never leaves a
  // half-written session behind.
  const tempPath = `${path}.arbiter-repair.tmp`;
  writeFileSync(tempPath, Buffer.concat(rebuilt));
  renameSync(tempPath, path);
  const repairedSha256 = sha256(readFileSync(path));

  return {
    ...inspection,
    backupPath,
    rewritten,
    untouchedEvents,
    changed: true,
    backupSha256,
    repairedSha256,
  };
}
