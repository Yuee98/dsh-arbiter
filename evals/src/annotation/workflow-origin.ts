import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

/** Git locates code/data when available; unknown origin stays explicit. */
export async function annotationOrigin(root: string) {
  try {
    const run = promisify(execFile);
    const [head, status] = await Promise.all([
      run('git', ['rev-parse', 'HEAD'], { cwd: root }),
      run('git', ['status', '--porcelain'], { cwd: root }),
    ]);
    return {
      sourceCommit: head.stdout.trim(),
      sourceDirty: status.stdout.length > 0,
    };
  } catch {
    return { sourceCommit: null, sourceDirty: null };
  }
}
