import { statSync } from 'node:fs';
import { toolResultFileBytes } from './tool-result-files.js';

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
