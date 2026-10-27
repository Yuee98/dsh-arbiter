import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';
import * as react from 'react';
import * as reactDom from 'react-dom';
import * as reactDomClient from 'react-dom/client';
import * as jsxRuntime from 'react/jsx-runtime';
import { publint } from 'publint';
import { formatMessage } from 'publint/utils';

const root = fileURLToPath(new URL('../', import.meta.url));
const temporary = await mkdtemp(join(tmpdir(), 'dsh-arbiter-build-'));
const consumer = join(temporary, 'consumer');
const tarball = join(temporary, 'dsh-arbiter.tgz');

function run(command: string, args: string[], cwd = consumer): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    env: { ...process.env, CI: 'true' },
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Build consumer verification failed.');
}

function runNode(args: string[]): void {
  run(process.execPath, args);
}

interface LoadedClient {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

try {
  await mkdir(consumer);
  // Exercise exactly the publishable files. A repo symlink can hide an omitted
  // runtime dependency, declaration, locale, or bundle-patch file.
  run('pnpm', ['pack', '--out', tarball], root);
  const lintResult = await publint({
    pack: { tarball: Uint8Array.from(await readFile(tarball)).buffer },
    strict: true,
  });
  const packageErrors = lintResult.messages.filter(
    (message) => message.type !== 'suggestion',
  );
  for (const message of packageErrors) {
    process.stderr.write(
      `${formatMessage(message, lintResult.pkg) ?? JSON.stringify(message)}\n`,
    );
  }
  assert.equal(packageErrors.length, 0, 'Publint found package defects.');
  await writeFile(
    join(consumer, 'package.json'),
    JSON.stringify({
      name: 'arbiter-packed-consumer',
      private: true,
      type: 'module',
      dependencies: { 'dsh-arbiter': `file:${tarball}` },
    }),
  );
  // The preceding frozen repo install populates the store. This check must not
  // fetch packages, run lifecycle scripts, or resolve through repo node_modules.
  run('pnpm', ['install', '--offline', '--ignore-scripts']);
  const packageRoot = join(consumer, 'node_modules/dsh-arbiter');
  assert.ok(
    (await realpath(packageRoot)).startsWith(`${await realpath(consumer)}/`),
    'The consumer must resolve an installed tarball, not the repository.',
  );

  runNode([
    '--input-type=module',
    '--eval',
    [
      "import assert from 'node:assert/strict';",
      "import { apply, inject, name } from 'dsh-arbiter';",
      "assert.equal(name, 'arbiter');",
      "assert.deepEqual(inject, ['tools','sessions','llm','approval','permissionPresets','workingDirectory']);",
      "assert.equal(typeof apply, 'function');",
      "assert.equal(import.meta.resolve('dsh-arbiter/package.json').includes('/consumer/'), true);",
      "assert.equal(import.meta.resolve('dsh-arbiter/client').endsWith('/lib/client.cjs'), true);",
    ].join('\n'),
  ]);

  await writeFile(
    join(consumer, 'consumer.mts'),
    [
      "import { apply, inject, name } from 'dsh-arbiter';",
      "const pluginName: 'arbiter' = name;",
      'const services: readonly string[] = inject;',
      'void pluginName;',
      'void services;',
      'void apply;',
      '// @ts-expect-error -- The plugin name is the literal "arbiter".',
      "const wrongName: 'other' = name;",
      'void wrongName;',
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

  // Verify the browser bundle is a loadable module factory with the expected
  // plugin exports. The component is not rendered here.
  const clientCode = await readFile(
    join(packageRoot, 'lib/client.cjs'),
    'utf8',
  );
  const holder: { value: LoadedClient | null } = { value: null };
  const context = createContext({
    window: {
      __ModuleLoader__: {
        load(spec: LoadedClient): void {
          holder.value = spec;
        },
      },
    },
    console,
  });
  runInContext(clientCode, context);
  if (holder.value === null) {
    throw new Error('client bundle did not register with the module loader');
  }
  const registered: LoadedClient = holder.value;
  assert.equal(registered.id, 'dsh-arbiter');
  assert.ok(
    clientCode.includes('dsh-arbiter-styles'),
    'client bundle must include dsh-arbiter-styles',
  );
  const clientExports = registered.factory((specifier: string) => {
    if (specifier === 'react/jsx-runtime') return jsxRuntime;
    if (specifier === 'react') return react;
    if (specifier === 'react-dom') return reactDom;
    if (specifier === 'react-dom/client') return reactDomClient;
    throw new Error(`Unexpected client external dependency: ${specifier}`);
  });
  assert.equal(
    isRecord(clientExports),
    true,
    'client factory did not return exports',
  );
  if (isRecord(clientExports)) {
    assert.equal(typeof clientExports['apply'], 'function');
    const injectValue = clientExports['inject'];
    assert.equal(Array.isArray(injectValue), true);
    if (Array.isArray(injectValue))
      assert.equal(injectValue.join(','), 'slots,locale');
  }
  const patch = await readFile(join(packageRoot, 'cordis.patch.yml'), 'utf8');
  assert.match(patch, /name: dsh-arbiter/);
  const localeFiles = (
    await readdir(join(root, 'locale'), { recursive: true })
  ).filter((file) => file.endsWith('.json'));
  assert.ok(localeFiles.includes('schema.json'));
  assert.ok(localeFiles.includes('zh/common.json'));
  assert.ok(localeFiles.includes('en/common.json'));
  for (const file of localeFiles) {
    const original = await readFile(join(root, 'locale', file), 'utf8');
    const packaged = await readFile(join(packageRoot, 'locale', file), 'utf8');
    assert.equal(
      packaged,
      original,
      `Packaged locale resource differs: ${file}`,
    );
  }
  process.stdout.write(
    'Packed consumer: runtime, types, client factory, patch and locales passed.\n',
  );
} finally {
  await rm(temporary, { recursive: true, force: true });
}
