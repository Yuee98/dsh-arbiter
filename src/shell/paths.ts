/**
 * Path text helpers.
 *
 * These operate on already-decoded values only: a canonical matching text may be
 * quoted, and resolving that as a path would read the quote as part of the name.
 */

/** Resolve a decoded path against a known working directory. */
export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/')) return normalizePath(path);
  if (path.startsWith('~')) return path;
  return normalizePath(`${cwd}/${path}`);
}

/** Collapse `.` and `..` segments without touching the filesystem. */
export function normalizePath(path: string): string {
  const absolute = path.startsWith('/');
  const parts: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (parts.length > 0) parts.pop();
      continue;
    }
    parts.push(part);
  }
  return `${absolute ? '/' : ''}${parts.join('/')}` || (absolute ? '/' : '.');
}
