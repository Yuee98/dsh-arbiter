import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

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

interface LoadedClient {
  readonly id: string;
  readonly factory: (require: (specifier: string) => unknown) => unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

try {
  await mkdir(join(consumer, 'node_modules'));
  await symlink(root, join(consumer, 'node_modules/dsh-arbiter'), 'dir');

  runNode([
    '--input-type=module',
    '--eval',
    [
      "import assert from 'node:assert/strict';",
      "import { apply, inject, name } from 'dsh-arbiter';",
      "assert.equal(name, 'arbiter');",
      "assert.deepEqual(inject, ['tools','sessions','llm','approval','permissionPresets','workingDirectory']);",
      "assert.equal(typeof apply, 'function');",
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
  const clientCode = await readFile(join(root, 'lib/client.js'), 'utf8');
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
  const jsx = (): null => null;
  const stub = (): null => null;
  const clientExports = registered.factory((specifier: string) => {
    if (specifier === 'react/jsx-runtime') {
      return { jsx, jsxs: jsx, Fragment: null };
    }
    if (specifier === 'react') {
      return {
        useState: stub,
        useEffect: stub,
        useCallback: stub,
        useMemo: stub,
        useRef: stub,
      };
    }
    return {};
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
      assert.equal(injectValue.join(','), 'slots');
  }
} finally {
  await rm(consumer, { recursive: true, force: true });
}
