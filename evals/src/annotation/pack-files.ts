/** Exclusive local artifacts and untrusted result reads. No external dispatch. */
import { constants } from 'node:fs';
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { dirname, join, parse, relative, resolve } from 'node:path';
import { canonicalJson } from '../data/hash.js';

export async function regularParents(path: string): Promise<void> {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute)
    .split(/[\\/]/u)
    .filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('unsafe artifact directory');
  }
}
export async function createParents(path: string): Promise<void> {
  const parent = dirname(path);
  if (parent !== path) {
    try {
      await regularParents(parent);
    } catch (error) {
      if (!(
        error instanceof Error &&
        'code' in error &&
        error.code === 'ENOENT'
      ))
        throw error;
      await createParents(parent);
      await mkdir(parent).catch(async (error: unknown) => {
        if (!(
          error instanceof Error &&
          'code' in error &&
          error.code === 'EEXIST'
        ))
          throw error;
        await regularParents(parent);
      });
    }
  }
  await regularParents(parent);
}
export async function artifactPath(
  root: string,
  name: string,
): Promise<string> {
  const actual = await realpath(root);
  const supplied = resolve(root, name);
  const local = relative(resolve(root), supplied);
  return local !== '..' && !local.startsWith('../')
    ? resolve(actual, local)
    : supplied;
}
export async function readRegular(path: string): Promise<string> {
  await regularParents(dirname(path));
  const parents = await lstat(dirname(path));
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1)
      throw new Error('result must be a regular single-link file');
    const current = await lstat(path);
    if (
      current.isSymbolicLink() ||
      current.ino !== before.ino ||
      current.dev !== before.dev
    )
      throw new Error('result path changed');
    const text = await handle.readFile('utf8');
    await regularParents(dirname(path));
    const after = await lstat(path),
      parentAfter = await lstat(dirname(path));
    if (
      after.isSymbolicLink() ||
      after.ino !== before.ino ||
      after.dev !== before.dev ||
      parents.ino !== parentAfter.ino ||
      parents.dev !== parentAfter.dev
    )
      throw new Error('result changed during read');
    return text;
  } finally {
    await handle.close();
  }
}
export async function exclusiveJson(
  path: string,
  value: unknown,
): Promise<void> {
  await createParents(path);
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', {
    flag: 'wx',
    mode: 0o600,
  });
}
export async function immutableJson(
  path: string,
  value: unknown,
): Promise<void> {
  try {
    await exclusiveJson(path, value);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST'))
      throw error;
    if (
      canonicalJson(JSON.parse(await readRegular(path)) as unknown) !==
      canonicalJson(value)
    )
      throw new Error('attempt payload conflicts with its immutable archive', {
        cause: error,
      });
  }
}
export async function absent(path: string): Promise<void> {
  try {
    await lstat(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return;
    throw error;
  }
  throw new Error(`output already exists: ${path}`);
}
export async function jsonFile(path: string): Promise<unknown> {
  // Operator-owned configuration; result inputs use readRegular instead.
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

/** Serialize competing publishers and preserve pre-existing output directories. */
export async function publishNewDirectory(
  stage: string,
  out: string,
): Promise<void> {
  await regularParents(dirname(out));
  const claim = `${out}.claim`;
  const lock = await open(claim, 'wx', 0o600);
  try {
    await absent(out);
    await rename(stage, out);
  } finally {
    await lock.close();
    await rm(claim);
  }
}
