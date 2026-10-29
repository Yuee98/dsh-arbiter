/**
 * Reading host session logs to report what they contain. Never rewriting them.
 *
 * The retired log-repair tool rewrote `plugin:arbiter/*` events and has been
 * removed (RQ-06). This module deliberately restores **none** of that: it
 * decompresses each log, counts the events this plugin wrote, and closes the
 * file. Session logs are host-owned — one log holds the whole conversation,
 * including every other plugin's records — so the reset tool reports them as an
 * excluded part of the impact scope and never deletes or edits one.
 *
 * A scan is also tolerant by design. A log written by another host version may
 * carry frames or lines this build cannot decode; a partial read still reports
 * the events it did decode, and the file reports how many frames failed so an
 * operator never reads "0 arbiter records" as proof that none exist.
 */
import { closeSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { zstdDecompressSync } from 'node:zlib';

/** The zstd frame magic that separates flushed frames in one log. */
const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);

/** Records this plugin owns, as the host stores them. */
const ARBITER_RECORD = /^plugin:arbiter\//u;

/** How many bytes one read pulls from a log. */
const CHUNK = 1 << 20;

/**
 * The default ceiling for scanning one log.
 *
 * A single session log is a whole conversation; the operator's real logs here are
 * tens of megabytes. The ceiling is high enough to cover them and low enough that
 * a stray multi-gigabyte file cannot turn the safety check into a reason to skip
 * it. A log over the limit is reported as not scanned, never as empty.
 */
export const DEFAULT_SCAN_LIMIT = 64 * 1024 * 1024;

/** One log's arbiter content, as the inventory reports it. */
export interface SessionLogFinding {
  /** Absolute path. */
  readonly path: string;
  /** Path relative to the data directory, for the operator's tally. */
  readonly relative: string;
  readonly bytes: number;
  readonly events: number;
  readonly arbiterRecords: number;
  /** Distinct `plugin:arbiter/*` types, sorted, so the record kinds are visible. */
  readonly recordTypes: readonly string[];
  /** Frames or lines the scan could not decode. */
  readonly undecodable: number;
  readonly problem: string | null;
}

/** Read one file completely. */
function readAll(path: string): Buffer {
  const size = statSync(path).size;
  const buffer = Buffer.alloc(size);
  const handle = openSync(path, 'r');
  try {
    let offset = 0;
    while (offset < size) {
      const read = readSync(
        handle,
        buffer,
        offset,
        Math.min(CHUNK, size - offset),
        offset,
      );
      if (read === 0) break;
      offset += read;
    }
    return offset === size ? buffer : buffer.subarray(0, offset);
  } finally {
    closeSync(handle);
  }
}

/** Split a zstd file into its frames, tolerating a truncated tail. */
function splitFrames(buffer: Buffer): readonly Buffer[] {
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
  if (starts.length === 0) return [];
  return starts.map((start, index) =>
    buffer.subarray(start, starts[index + 1] ?? buffer.length),
  );
}

/** One decoded JSON line, when it has the shape of a committed event. */
function eventOf(line: string): { readonly type: string } | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed))
    return null;
  const type: unknown = Reflect.get(parsed, 'type');
  return typeof type === 'string' ? { type } : null;
}

/** What one scan accumulated. */
interface ScanCounts {
  events: number;
  arbiterRecords: number;
  readonly types: Set<string>;
  undecodable: number;
}

/** Count this plugin's records in one decoded log body. */
function countBody(text: string, counts: ScanCounts): void {
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue;
    const event = eventOf(line);
    if (event === null) {
      // A file that is not line-delimited JSON is a different problem from a
      // frame this build cannot decompress; both are reported, neither is
      // silently counted as "no arbiter records".
      counts.undecodable += 1;
      continue;
    }
    counts.events += 1;
    if (!ARBITER_RECORD.test(event.type)) continue;
    counts.arbiterRecords += 1;
    counts.types.add(event.type);
  }
}

/**
 * Count this plugin's records in one session log.
 *
 * `relative` is carried through so a report can name the file without printing
 * an absolute home the operator did not ask for.
 */
export function scanSessionLog(
  path: string,
  relative: string,
  options: { readonly maxBytes?: number } = {},
): SessionLogFinding {
  const bytes = statSync(path).size;
  const counts: ScanCounts = {
    events: 0,
    arbiterRecords: 0,
    types: new Set(),
    undecodable: 0,
  };
  if (options.maxBytes !== undefined && bytes > options.maxBytes) {
    return {
      path,
      relative,
      bytes,
      events: 0,
      arbiterRecords: 0,
      recordTypes: [],
      undecodable: 0,
      problem: `not scanned: ${String(bytes)} bytes exceeds the ${String(
        options.maxBytes,
      )}-byte scan limit`,
    };
  }
  let problem: string | null = null;
  try {
    const frames = splitFrames(readAll(path));
    if (frames.length === 0) problem = 'no zstd frame was found';
    for (const frame of frames) {
      // One bad frame does not invalidate the others: the host appends a frame
      // per flush, so a damaged tail leaves the earlier records countable.
      try {
        countBody(zstdDecompressSync(frame).toString('utf8'), counts);
      } catch {
        counts.undecodable += 1;
      }
    }
  } catch (error) {
    problem = `could not be read: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  return {
    path,
    relative,
    bytes,
    events: counts.events,
    arbiterRecords: counts.arbiterRecords,
    recordTypes: [...counts.types].sort(),
    undecodable: counts.undecodable,
    problem,
  };
}

/** A bounded depth for the host's `sessions/<workspace>/<id>/<log>` layout. */
const MAX_DEPTH = 3;

/** The log files under one directory tree, relative to the tree root. */
function logFiles(
  root: string,
  directory: string,
  depth: number,
  found: string[],
): void {
  if (depth > MAX_DEPTH) return;
  let names: readonly string[];
  try {
    names = readdirSync(directory);
  } catch {
    return;
  }
  for (const name of names) {
    const path = join(directory, name);
    let stats;
    try {
      stats = statSync(path, { throwIfNoEntry: false });
    } catch {
      continue;
    }
    if (stats === undefined) continue;
    if (stats.isDirectory()) {
      logFiles(root, path, depth + 1, found);
      continue;
    }
    // The host renames a temporary sibling into place, so a `.tmp` file is a
    // write in progress rather than a log.
    if (!name.startsWith('session.') || !name.includes('jsonl')) continue;
    if (name.endsWith('.tmp')) continue;
    found.push(path);
  }
}

/**
 * Scan every host session log under one data directory.
 *
 * The result is reported in the plan and never acted on: it exists so the
 * operator can see how much of the old history lives in host-owned files that
 * this tool will not rewrite.
 *
 * Each log has a byte ceiling, because a report that takes minutes to produce
 * invites skipping the check it exists for. A log over the limit is reported as
 * not scanned rather than counted as empty.
 */
export function scanSessionLogs(
  root: string,
  options: { readonly maxBytes?: number } = {},
): readonly SessionLogFinding[] {
  const found: string[] = [];
  logFiles(root, root, 0, found);
  found.sort();
  const limit = options.maxBytes ?? DEFAULT_SCAN_LIMIT;
  return found.map((path) =>
    scanSessionLog(path, relative(root, path), { maxBytes: limit }),
  );
}
