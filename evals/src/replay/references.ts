/** One invocation owns one byte snapshot, shared by every candidate. */
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { readReferenceSnapshot } from '../metrics/reference-snapshot.js';

export interface ReferenceEvidence {
  readonly sourcePath: string;
  readonly path: string;
  readonly digest: string;
}
export interface FrozenReference extends ReferenceEvidence {
  readonly bytes: Buffer;
}
function digest(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
export async function freezeReferences(
  root: string,
  paths: readonly string[],
): Promise<readonly FrozenReference[]> {
  const frozen: FrozenReference[] = [];
  for (const [index, path] of paths.entries()) {
    const sourcePath = resolve(root, path);
    const bytes = await readFile(sourcePath);
    frozen.push({
      sourcePath,
      path: `references/reference-${String(index + 1)}.json`,
      digest: digest(bytes),
      bytes,
    });
  }
  return frozen;
}
export async function copyReferences(
  directory: string,
  references: readonly FrozenReference[],
): Promise<readonly ReferenceEvidence[]> {
  const evidence: ReferenceEvidence[] = [];
  for (const reference of references) {
    const path = join(directory, reference.path);
    await mkdir(join(directory, 'references'), { recursive: true });
    await writeFile(path, reference.bytes, { flag: 'wx' });
    await readReferenceSnapshot(path);
    evidence.push({
      sourcePath: reference.sourcePath,
      path: reference.path,
      digest: reference.digest,
    });
  }
  return evidence;
}
/** Verify the actual copies read by the report, not the mutable original paths. */
export async function referencesMatch(
  directory: string,
  value: unknown,
): Promise<boolean> {
  if (value === undefined) return true;
  if (!Array.isArray(value)) return false;
  const seen = new Set<string>();
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry))
      return false;
    const path: unknown = Reflect.get(entry, 'path'),
      expected: unknown = Reflect.get(entry, 'digest');
    if (
      typeof path !== 'string' ||
      !/^references\/reference-[1-9]\d*\.json$/u.test(path) ||
      seen.has(path) ||
      typeof expected !== 'string' ||
      !/^sha256:[a-f0-9]{64}$/u.test(expected) ||
      typeof Reflect.get(entry, 'sourcePath') !== 'string'
    )
      return false;
    seen.add(path);
    if (digest(await readFile(join(directory, path))) !== expected)
      return false;
  }
  return true;
}
