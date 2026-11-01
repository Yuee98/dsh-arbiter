import { lstatSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { toolResultFileBytes } from './tool-result-files.js';

/** One physical namespace for SQLite, sidecars, body files and live ownership. */
export function auditStoragePath(path: string): string {
  if (path === ':memory:') return path;
  try {
    return realpathSync(path);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT' ||
      lstatSync(path, { throwIfNoEntry: false }) !== undefined
    )
      throw error;
    return join(realpathSync(dirname(path)), basename(path));
  }
}

function fileBytes(paths: readonly string[]): number {
  let bytes = 0;
  for (const path of paths) {
    try {
      bytes += statSync(path).size;
    } catch {
      /* Missing sidecars are normal. */
    }
  }
  return bytes;
}
export function auditSidecarBytes(path: string): number {
  return fileBytes([`${path}-wal`, `${path}-shm`]);
}
export function auditWalBytes(path: string): number {
  return fileBytes([`${path}-wal`]);
}
export function auditTotalBytes(path: string, onFailure: () => void): number {
  let bytes = fileBytes([path]) + auditSidecarBytes(path);
  try {
    bytes += toolResultFileBytes(path);
  } catch {
    onFailure();
  }
  return bytes;
}

export function resolveAuditPath(dshHome: string): string {
  return `${dshHome}/arbiter/arbiter.db`;
}
