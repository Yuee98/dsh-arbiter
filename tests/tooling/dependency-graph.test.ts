import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cruise } from 'dependency-cruiser';
import extractTsConfig from 'dependency-cruiser/config-utl/extract-ts-config';
import { describe, expect, it } from 'vitest';

import configuration from '../../dependency-cruiser.config.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));

async function inspectGraph(files: Readonly<Record<string, string>>) {
  const fixture = await realpath(
    await mkdtemp(join(tmpdir(), 'arbiter-dependency-graph-')),
  );
  try {
    for (const [name, source] of Object.entries(files)) {
      await writeFile(join(fixture, name), source);
    }
    const result = await cruise(
      ['.'],
      {
        ...configuration.options,
        baseDir: fixture,
        validate: true,
        ruleSet: configuration,
      },
      undefined,
      { tsConfig: extractTsConfig(join(root, 'tsconfig.json')) },
    );
    if (typeof result.output === 'string') {
      throw new Error('Dependency analysis did not return its graph.');
    }
    return result.output;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

describe('runtime dependency graph', () => {
  it('rejects runtime cycles through TSX and NodeNext .js specifiers', async () => {
    const graph = await inspectGraph({
      'a.tsx': "import { b } from './b.js'; export const a = () => b();",
      'b.ts': "import { a } from './a.js'; export const b = () => a();",
    });
    expect(graph.summary.violations).toEqual([
      expect.objectContaining({
        rule: { name: 'no-runtime-cycles', severity: 'error' },
      }),
    ]);
    expect(graph.modules.filter((module) => module.couldNotResolve)).toEqual(
      [],
    );
  });

  it('rejects cycles through literal dynamic imports', async () => {
    const graph = await inspectGraph({
      'a.ts': "export const a = () => import('./b.js');",
      'b.ts': "export const b = () => import('./a.js');",
    });
    expect(graph.summary.violations).toEqual([
      expect.objectContaining({
        rule: { name: 'no-runtime-cycles', severity: 'error' },
      }),
    ]);
  });

  it('allows a type-only cycle erased from runtime output', async () => {
    const graph = await inspectGraph({
      'a.ts': "import type { B } from './b.js'; export interface A { b?: B }",
      'b.ts': "import type { A } from './a.js'; export interface B { a?: A }",
    });
    expect(graph.modules).toHaveLength(2);
    expect(graph.summary.violations).toEqual([]);
  });

  it('allows a runtime edge whose return edge is type-only', async () => {
    const graph = await inspectGraph({
      'a.ts':
        "import type { B } from './b.js'; export const a = 1; export interface A { b?: B }",
      'b.ts':
        "import { a } from './a.js'; export const b = a; export interface B { value: number }",
    });
    expect(graph.modules).toHaveLength(2);
    expect(graph.summary.violations).toEqual([]);
  });
});
