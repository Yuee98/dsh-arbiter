/** Replay origin and reference copies are read evidence too, including a third source run. */
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { REPLAY_IMPLEMENTATION_VERSION } from '../replay/types.js';
import type { Observation } from '../metrics/observe.js';
import type { EvidencePath } from './write.js';

export async function comparisonEvidence(
  directory: string,
  root: string,
  observation: Observation,
): Promise<readonly EvidencePath[]> {
  if (
    observation.artifact.index.versions.implementation !==
    REPLAY_IMPLEMENTATION_VERSION
  )
    return [];
  const evidence: EvidencePath[] = [
    { path: join(directory, 'lineage.json'), kind: 'file' },
    { path: join(directory, 'references'), kind: 'directory' },
  ];
  try {
    const raw: unknown = JSON.parse(
      await readFile(join(directory, 'lineage.json'), 'utf8'),
    );
    if (raw === null || typeof raw !== 'object') return evidence;
    const source: unknown = Reflect.get(raw, 'source');
    if (source === null || typeof source !== 'object') return evidence;
    const path: unknown = Reflect.get(source, 'directory');
    if (typeof path === 'string')
      evidence.push({ path: resolve(root, path), kind: 'directory' });
  } catch {
    // A missing/unreadable origin remains unverified; preserve any surviving proof files.
  }
  return evidence;
}
