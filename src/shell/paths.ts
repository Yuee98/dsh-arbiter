export function hasUnresolved(value: string): boolean {
  return value.includes('$') || value.includes('`');
}

export function resolvePath(path: string, cwd: string): string {
  if (path.startsWith('/')) return normalizePath(path);
  if (path.startsWith('~')) return path;
  return normalizePath(`${cwd}/${path}`);
}

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
