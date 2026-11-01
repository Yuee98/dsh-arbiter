/** Grouped legacy CLI registration, keeping case consumers and historical reads separate. */
import { resolve } from 'node:path';
import { isLegacyCollection } from '../data/legacy-read.js';
import { migrateLegacy } from '../data/legacy-migrate.js';
import { exportLegacyBatch, importLegacyBatch } from './legacy-batch.js';
interface Io {
  readonly root: string;
  readonly out: (s: string) => void;
  readonly err: (s: string) => void;
}
export async function runLegacyCommand(
  argv: readonly string[],
  io: Io,
): Promise<number | null> {
  const [command, dataset, ...rest] = argv;
  if (command === 'migrate-legacy') {
    if (dataset === undefined || rest.some((x) => x !== '--check')) {
      io.err('usage: evals migrate-legacy <destination> [--check]');
      return 2;
    }
    const files = await migrateLegacy(
      resolve(io.root, 'evals/datasets/core-v1'),
      resolve(io.root, dataset),
      !rest.includes('--check'),
    );
    io.out(
      `legacy-v1: ${String(files.length)} losslessly mapped collection files; historical holdout is regression only`,
    );
    return 0;
  }
  if (
    (command !== 'export' && command !== 'import') ||
    dataset === undefined ||
    !(await isLegacyCollection(resolve(io.root, dataset)))
  )
    return null;
  const flags = new Map<string, string>();
  let write = false;
  for (let index = 0; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === '--write' && command === 'import') {
      write = true;
      continue;
    }
    if (
      flag === undefined ||
      !['--split', command === 'export' ? '--out' : '--fill'].includes(flag) ||
      flags.has(flag) ||
      rest[index + 1] === undefined
    ) {
      io.err('unknown, duplicate or incomplete legacy annotation option');
      return 2;
    }
    flags.set(flag, rest[++index] ?? '');
  }
  const split = flags.get('--split') ?? 'dev';
  if (split !== 'dev' && split !== 'calibration' && split !== 'holdout') {
    io.err(
      'annotation writes one legacy group at a time: --split dev|calibration|holdout',
    );
    return 2;
  }
  if (command === 'export') {
    const out = flags.get('--out');
    if (out === undefined) {
      io.err('export needs --out');
      return 2;
    }
    const count = await exportLegacyBatch(io.root, dataset, split, out);
    io.out(
      `wrote ${String(count)} blank legacy entries; ${split}/legacy-v1 is historical regression`,
    );
    return 0;
  }
  const fill = flags.get('--fill');
  if (fill === undefined) {
    io.err('import needs --fill');
    return 2;
  }
  const count = await importLegacyBatch(io.root, dataset, fill, write, split);
  io.out(
    `${write ? 'wrote' : 'validated'} ${String(count)} legacy labels${write ? '' : ' (read-only; use --write to store)'}`,
  );
  return 0;
}
