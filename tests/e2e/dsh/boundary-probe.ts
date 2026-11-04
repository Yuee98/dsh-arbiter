import { existsSync } from 'node:fs';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, sep } from 'node:path';
import { isRecord } from '../../../src/config/values.js';
import type { CaseHost } from './case-host.js';

export interface BoundaryProbe {
  readonly directory: string;
  readonly dispose: () => Promise<void>;
}

function inside(root: string, path: string): boolean {
  const suffix = relative(root, path);
  return (
    suffix === '' ||
    (!isAbsolute(suffix) && suffix !== '..' && !suffix.startsWith('..' + sep))
  );
}

/** Mount only in the two cases that need an actual-runtime boundary probe. */
export function boundaryRootsRow(artifacts: string): Record<string, unknown> {
  return {
    insert: [
      {
        id: 'arbiter-boundary-roots',
        name: new URL('./boundary-runtime/index.ts', import.meta.url).href,
        config: { outputPath: join(artifacts, 'sandbox-roots.json') },
      },
    ],
  };
}

/** Consume the selected host's allowlist, never a different installed SDK. */
async function writableRoots(
  artifacts: string,
  workspace: string,
): Promise<readonly string[]> {
  const evidence: unknown = JSON.parse(
    await readFile(join(artifacts, 'sandbox-roots.json'), 'utf8'),
  );
  if (!isRecord(evidence) || evidence['workspace'] !== workspace)
    throw new Error('sandbox roots do not belong to this host workspace');
  const value = evidence['writableRoots'];
  if (!Array.isArray(value)) throw new Error('invalid runtime writable roots');
  if (!value.includes(workspace))
    throw new Error('runtime writable roots omit this host workspace');
  return value.map((root: unknown) => {
    if (typeof root !== 'string' || !isAbsolute(root))
      throw new Error('invalid writable root');
    return root;
  });
}

/** Own only a fresh private directory that the confined host must not write. */
export async function createBoundaryProbe(
  artifacts: string,
  workspace: string,
): Promise<BoundaryProbe> {
  await mkdir(artifacts, { recursive: true });
  const roots = await writableRoots(artifacts, await realpath(workspace));
  const artifactRoot = await realpath(artifacts);
  const parent = roots.some((root) => inside(root, artifactRoot))
    ? await realpath(homedir())
    : artifactRoot;
  if (roots.some((root) => inside(root, parent)))
    throw new Error('no owned probe base outside the runtime writable roots');
  const directory = await realpath(
    await mkdtemp(join(parent, '.arbiter-boundary-')),
  );
  const evidence = join(artifacts, 'boundary-probe.json');
  try {
    await chmod(directory, 0o700);
    if (roots.some((root) => inside(root, directory)))
      throw new Error('negative probe resolved into a permitted root');
    const control = join(directory, 'ambient-control.txt');
    await writeFile(control, 'ambient-writable', { flag: 'wx', mode: 0o600 });
    if ((await readFile(control, 'utf8')) !== 'ambient-writable')
      throw new Error('ambient write control did not round-trip');
    await rm(control);
    const identity = {
      workspace,
      writableRoots: roots,
      directory,
      ambientWritable: true,
      mode: '0700',
    };
    await writeFile(evidence, JSON.stringify(identity, null, 2));
    return {
      directory,
      dispose: async () => {
        await rm(directory, { recursive: true, force: true });
        if (existsSync(directory)) throw new Error('negative probe leaked');
        await writeFile(
          evidence,
          JSON.stringify({ ...identity, directoryRemoved: true }, null, 2),
        );
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** Capture native evidence before real host disposal, then remove our probe. */
export async function disposeBoundaryCase(
  host: CaseHost,
  probe: BoundaryProbe | undefined,
  artifacts: string,
): Promise<void> {
  try {
    await writeFile(
      join(artifacts, 'native-sessions.json'),
      JSON.stringify(await host.logs(), null, 2),
    );
  } finally {
    try {
      await host.dispose();
    } finally {
      await probe?.dispose();
    }
  }
}
