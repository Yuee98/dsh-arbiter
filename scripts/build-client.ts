import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildCss } from './build-css.ts';

const root = fileURLToPath(new URL('../', import.meta.url));
const outfile = `${root}lib/client.cjs`;

/**
 * Host modules the web shell publishes to every plugin bundle.
 *
 * `react`, `react-dom` and their runtime entries come from the platform seed;
 * so does `@deepseek-ai/dsh-client-ui-primitives`, which the host's own
 * permission selector requires through the same module table. Keeping it
 * external is what lets this plugin render the host's real `Menu` and
 * `RiskConfirmation` instead of a copy, and it avoids shipping a second copy of
 * the host's component library.
 */
const HOST_EXTERNALS = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const;

await buildCss({ write: true });

const result = await build({
  entryPoints: [`${root}src/client/index.tsx`],
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  external: [...HOST_EXTERNALS],
  write: false,
  sourcemap: false,
  minify: false,
  legalComments: 'none',
  logLevel: 'silent',
});

const output = result.outputFiles[0];
if (output === undefined) throw new Error('client bundle produced no output');

const wrapped = [
  'window.__ModuleLoader__.load({',
  '  id: "dsh-arbiter",',
  '  factory: (require) => {',
  '    var module = { exports: {} };',
  '    var exports = module.exports;',
  output.text,
  '    return module.exports;',
  '  },',
  '});',
  '',
].join('\n');

await mkdir(dirname(outfile), { recursive: true });
await writeFile(outfile, wrapped, 'utf8');
console.log(
  `client bundle written to ${outfile} (${String(wrapped.length)} bytes)`,
);
