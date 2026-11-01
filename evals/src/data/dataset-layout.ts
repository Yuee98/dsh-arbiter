/** One layout discriminator shared by readers and annotation command routing. */
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
export async function hasDatasetManifest(dataset: string): Promise<boolean> {
  try {
    await lstat(join(dataset, 'manifest.json'));
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return false;
    throw error;
  }
}
export async function isLegacyCollection(dataset: string): Promise<boolean> {
  // Even an invalid manifest retains precedence: report its error rather than
  // silently interpreting its cases under an unrelated historical authority.
  if (await hasDatasetManifest(dataset)) return false;
  for (const split of ['dev', 'calibration', 'holdout']) {
    try {
      if ((await lstat(join(dataset, split, 'legacy-v1'))).isDirectory())
        return true;
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
    }
  }
  return false;
}
