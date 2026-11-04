import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { createBoundaryProbe } from '../e2e/dsh/boundary-probe.js';

let root: string;
let workspace: string;
let artifacts: string;

beforeEach(async () => {
  root = await realpath(
    await mkdtemp(join(tmpdir(), 'arbiter-boundary-input-')),
  );
  workspace = join(root, 'workspace');
  artifacts = join(root, 'artifacts');
  await mkdir(workspace);
  await mkdir(artifacts);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function evidence(value: unknown): Promise<void> {
  await writeFile(join(artifacts, 'sandbox-roots.json'), JSON.stringify(value));
}

it('uses only this host workspace evidence and removes the owned probe', async () => {
  await evidence({ workspace, writableRoots: [workspace] });
  const probe = await createBoundaryProbe(artifacts, workspace);
  expect(probe.directory.startsWith(artifacts)).toBe(true);
  const captured: unknown = JSON.parse(
    await readFile(join(artifacts, 'boundary-probe.json'), 'utf8'),
  );
  expect(captured).toMatchObject({
    workspace,
    writableRoots: [workspace],
    ambientWritable: true,
  });
  await probe.dispose();
  await expect(access(probe.directory)).rejects.toMatchObject({
    code: 'ENOENT',
  });
  expect(
    JSON.parse(await readFile(join(artifacts, 'boundary-probe.json'), 'utf8')),
  ).toMatchObject({ directoryRemoved: true });
});

it('fails instead of falling back to another runtime when host evidence is missing', async () => {
  await expect(createBoundaryProbe(artifacts, workspace)).rejects.toMatchObject(
    { code: 'ENOENT' },
  );
});

it('rejects a captured allowlist from another workspace', async () => {
  await evidence({
    workspace: join(root, 'other'),
    writableRoots: [workspace],
  });
  await expect(createBoundaryProbe(artifacts, workspace)).rejects.toThrow(
    'this host workspace',
  );
});

it.each([null, [], ['relative']])(
  'rejects malformed or incomplete roots %j before creating a probe',
  async (writableRoots) => {
    await evidence({ workspace, writableRoots });
    await expect(createBoundaryProbe(artifacts, workspace)).rejects.toThrow(
      /writable root/u,
    );
    await expect(
      access(join(artifacts, 'boundary-probe.json')),
    ).rejects.toMatchObject({ code: 'ENOENT' });
  },
);

it('rejects a non-string root even alongside the current workspace', async () => {
  await evidence({ workspace, writableRoots: [workspace, 7] });
  await expect(createBoundaryProbe(artifacts, workspace)).rejects.toThrow(
    'invalid writable root',
  );
  await expect(
    access(join(artifacts, 'boundary-probe.json')),
  ).rejects.toMatchObject({
    code: 'ENOENT',
  });
});
