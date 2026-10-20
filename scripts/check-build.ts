import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const consumer = await mkdtemp(join(tmpdir(), 'dsh-arbiter-build-'));

function runNode(args: string[]): void {
  const result = spawnSync(process.execPath, args, {
    cwd: consumer,
    stdio: 'inherit',
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Build consumer verification failed.');
}

try {
  await mkdir(join(consumer, 'node_modules'));
  await symlink(root, join(consumer, 'node_modules/dsh-arbiter'), 'dir');

  runNode([
    '--input-type=module',
    '--eval',
    "import assert from 'node:assert/strict'; import { scaffold } from 'dsh-arbiter'; assert.equal(scaffold, 'dsh-arbiter');",
  ]);

  await writeFile(
    join(consumer, 'consumer.mts'),
    [
      "import { scaffold } from 'dsh-arbiter';",
      "const name: 'dsh-arbiter' = scaffold;",
      'void name;',
      '// @ts-expect-error -- The dummy export is a string, not a number.',
      'const numericName: number = scaffold;',
      'void numericName;',
      '',
    ].join('\n'),
  );
  await writeFile(
    join(consumer, 'tsconfig.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2023',
        module: 'NodeNext',
        strict: true,
        noEmit: true,
        types: [],
        skipLibCheck: false,
      },
      files: ['consumer.mts'],
    }),
  );
  runNode([
    fileURLToPath(import.meta.resolve('typescript/lib/tsc.js')),
    '--project',
    join(consumer, 'tsconfig.json'),
  ]);
} finally {
  await rm(consumer, { recursive: true, force: true });
}
