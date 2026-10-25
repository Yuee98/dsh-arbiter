import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { zstdCompressSync, zstdDecompressSync } from 'node:zlib';
import { afterEach, describe, expect, test } from 'vitest';

import { inspectSessionLog, repairSessionLog } from '../src/repair.js';

const dirs: string[] = [];

async function logWith(lines: readonly unknown[]): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'arbiter-repair-'));
  dirs.push(dir);
  const path = join(dir, 'session.v4.jsonl.zstd');
  const text = lines.map((line) => JSON.stringify(line)).join('\n') + '\n';
  await writeFile(path, zstdCompressSync(Buffer.from(text, 'utf8')));
  return path;
}

afterEach(async () => {
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

const legacy = {
  type: 'plugin:arbiter/decision',
  seq: 1,
  time: 2,
  data: { callId: 'call-1', tool: 'bash', result: 'allow' },
};

const compatible = {
  type: 'plugin:arbiter/decision',
  seq: 3,
  time: 4,
  data: { callId: 'call-2', tool: 'write', result: 'deny' },
  ignorable: true,
};

const hostEvent = {
  type: 'permission/preset',
  seq: 0,
  time: 1,
  data: { preset: 'workspace-write' },
};

const foreignRecord = {
  type: 'plugin:other/thing',
  seq: 2,
  time: 3,
  data: {},
};

describe('session log repair', () => {
  test('finds only arbiter records missing the marker', async () => {
    const path = await logWith([hostEvent, legacy, foreignRecord, compatible]);
    const found = inspectSessionLog(path);
    expect(found.repairable).toEqual([
      { seq: 1, type: 'plugin:arbiter/decision' },
    ]);
    expect(found.alreadyIgnorable).toEqual([
      { seq: 3, type: 'plugin:arbiter/decision' },
    ]);
    expect(found.foreignNonIgnorable).toEqual([
      { seq: 2, type: 'plugin:other/thing' },
    ]);
    expect(found.events).toBe(4);
  });

  test('dry run writes nothing', async () => {
    const path = await logWith([hostEvent, legacy]);
    const before = await readFile(path);
    const preview = repairSessionLog(path, { dryRun: true });
    expect(preview.changed).toBe(false);
    expect(preview.rewritten).toHaveLength(1);
    expect(preview.backupPath).toBeNull();
    expect(await readFile(path)).toEqual(before);
  });

  test('repair adds the marker, keeps other events, and backs up first', async () => {
    const path = await logWith([hostEvent, legacy, foreignRecord, compatible]);
    const original = await readFile(path);
    const result = repairSessionLog(path);
    expect(result.changed).toBe(true);
    expect(result.rewritten).toEqual([
      { seq: 1, type: 'plugin:arbiter/decision' },
    ]);
    expect(result.untouchedEvents).toBe(3);
    expect(result.backupPath).not.toBeNull();
    // The backup is byte-identical to the pre-repair file.
    expect(await readFile(result.backupPath ?? '')).toEqual(original);

    const repaired = zstdDecompressSync(await readFile(path))
      .toString('utf8')
      .split('\n')
      .filter((line) => line !== '')
      .map((line) => JSON.parse(line) as unknown);
    expect(repaired).toHaveLength(4);
    expect(repaired[0]).toEqual(hostEvent);
    expect(repaired[1]).toEqual({ ...legacy, ignorable: true });
    // A foreign record missing the marker is reported but never rewritten.
    expect(repaired[2]).toEqual(foreignRecord);
    expect(repaired[3]).toEqual(compatible);
  });

  test('repair is idempotent', async () => {
    const path = await logWith([hostEvent, legacy]);
    repairSessionLog(path);
    const second = repairSessionLog(path);
    expect(second.changed).toBe(false);
    expect(second.repairable).toHaveLength(0);
    expect(inspectSessionLog(path).alreadyIgnorable).toHaveLength(1);
  });

  test('a clean log is left untouched and gets no backup', async () => {
    const path = await logWith([hostEvent, compatible]);
    const before = await readFile(path);
    const result = repairSessionLog(path);
    expect(result.changed).toBe(false);
    expect(result.backupPath).toBeNull();
    expect(await readFile(path)).toEqual(before);
  });
});
