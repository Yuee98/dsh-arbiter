import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  opendirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { ToolResultRecovery } from './tool-result-types.js';
import { asRow, rowText } from './rows.js';
import { MAX_RESULT_BYTES } from './tool-result-slicing.js';

const OWNED =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}\.(?:body|tmp)$/u;
export function toolResultDirectory(path: string): string {
  return `${path}.results`;
}
function safeDirectory(path: string, create: boolean): string | null {
  const directory = toolResultDirectory(path);
  if (!existsSync(directory)) {
    if (!create) return null;
    mkdirSync(directory, { mode: 0o700 });
  }
  const info = lstatSync(directory);
  if (!info.isDirectory() || info.isSymbolicLink())
    throw new Error('unsafe-result-directory');
  return directory;
}
function ownedPath(path: string, reference: string): string {
  if (!OWNED.test(reference)) throw new Error('unsafe-result-reference');
  const directory = safeDirectory(path, false);
  if (directory === null)
    throw Object.assign(new Error('missing-result-directory'), {
      code: 'ENOENT',
    });
  return join(directory, reference);
}
function syncDirectory(directory: string): void {
  // Windows does not provide a directory handle supporting fsync through Node.
  if (process.platform === 'win32') return;
  const descriptor = openSync(directory, 'r');
  try {
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}
/** Caller holds BEGIN IMMEDIATE until the reference commits. */
export function publishToolResult(
  path: string,
  resultId: string,
  body: Buffer,
): string {
  if (path === ':memory:') throw new Error('result-files-unavailable');
  const directory = safeDirectory(path, true);
  if (directory === null) throw new Error('result-files-unavailable');
  const temporary = join(directory, `${resultId}.tmp`);
  const reference = `${resultId}.body`;
  const descriptor = openSync(
    temporary,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  try {
    writeFileSync(descriptor, body);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, join(directory, reference));
  syncDirectory(directory);
  return reference;
}
export function readToolResultFile(
  path: string,
  reference: string,
  bytes: number,
  hash: string,
): Buffer {
  const candidate = ownedPath(path, reference);
  if (lstatSync(candidate).isSymbolicLink())
    throw new Error('unsafe-result-reference');
  const descriptor = openSync(
    candidate,
    constants.O_RDONLY | constants.O_NOFOLLOW,
  );
  try {
    const info = fstatSync(descriptor);
    if (!info.isFile() || info.size !== bytes || bytes > MAX_RESULT_BYTES)
      throw new Error('corrupt-result-body');
    const body = readFileSync(descriptor);
    if (
      body.length !== bytes ||
      createHash('sha256').update(body).digest('hex') !== hash
    )
      throw new Error('corrupt-result-body');
    return body;
  } finally {
    closeSync(descriptor);
  }
}
function eachOwned(
  path: string,
  action: (reference: string, candidate: string) => void,
): void {
  const directory = safeDirectory(path, false);
  if (directory === null) return;
  const entries = opendirSync(directory);
  try {
    for (
      let entry = entries.readSync();
      entry !== null;
      entry = entries.readSync()
    )
      if (OWNED.test(entry.name))
        action(entry.name, join(directory, entry.name));
  } finally {
    entries.closeSync();
  }
}
export function toolResultFileBytes(path: string): number {
  let bytes = 0;
  eachOwned(path, (_reference, candidate) => {
    bytes += lstatSync(candidate).size;
  });
  return bytes;
}
export function missingResultFile(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
/** Caller holds the database write lock, fencing every publisher and cleaner. */
export function reclaimToolResultFiles(
  db: DatabaseSync,
  path: string,
): ToolResultRecovery {
  let removed = 0;
  let failed = false;
  const referenced = db.prepare(
    'SELECT 1 FROM tool_results WHERE file_ref = ?',
  );
  const forget = db.prepare(
    'DELETE FROM tool_result_garbage WHERE file_ref = ?',
  );
  const remove = (reference: string, candidate: string): void => {
    if (referenced.get(reference) !== undefined) return;
    try {
      // unlink removes a symlink itself; it never follows it into another file.
      unlinkSync(candidate);
      removed += 1;
      forget.run(reference);
    } catch (error) {
      if (missingResultFile(error)) forget.run(reference);
      else {
        failed = true;
        db.prepare(
          'INSERT OR IGNORE INTO tool_result_garbage(file_ref) VALUES (?)',
        ).run(reference);
      }
    }
  };
  eachOwned(path, remove);
  // A file already missing still releases its durable deletion intent.
  let cursor = '';
  for (;;) {
    const batch = db
      .prepare(
        'SELECT file_ref FROM tool_result_garbage WHERE file_ref > ? ORDER BY file_ref LIMIT 32',
      )
      .all(cursor);
    if (batch.length === 0) break;
    for (const value of batch) {
      const reference = rowText(asRow(value)['file_ref']);
      cursor = reference;
      try {
        remove(reference, ownedPath(path, reference));
      } catch (error) {
        if (
          missingResultFile(error) ||
          (safeDirectory(path, false) === null && OWNED.test(reference))
        )
          forget.run(reference);
        else failed = true;
      }
    }
  }
  return { ok: !failed, removed, cleanupPending: failed };
}
