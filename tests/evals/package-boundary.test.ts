/**
 * What may not reach the published package.
 *
 * `pnpm check:build` runs these against the real tarball, but a check that only runs
 * during packaging is easy to weaken without noticing. The logic is exercised here
 * on both sides: a listing or a module that does reach into evals must be caught, and
 * an ordinary project that merely mentions the word must not be.
 */

import { describe, expect, it } from 'vitest';

import {
  evalsSpecifiers,
  forbiddenEntries,
} from '../../scripts/build/package-boundary.js';

describe('published tarball entries', () => {
  it('accepts a listing with no evals path', () => {
    expect(
      forbiddenEntries(
        [
          'package/package.json',
          'package/lib/index.js',
          'package/locale/zh/common.json',
          '',
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('catches evals sources, schemas and data', () => {
    expect(
      forbiddenEntries(
        [
          'package/lib/index.js',
          'package/evals/src/cli.ts',
          'package/evals/schemas/case.schema.json',
          'package/evals/datasets/core-v1/manifest.json',
        ].join('\n'),
      ),
    ).toEqual([
      'package/evals/src/cli.ts',
      'package/evals/schemas/case.schema.json',
      'package/evals/datasets/core-v1/manifest.json',
    ]);
  });

  it('does not trip on a project file that merely mentions evals', () => {
    // A README describing the subproject is not the subproject; matching a substring
    // anywhere in a path would make the check unusable.
    expect(
      forbiddenEntries(
        ['package/docs/evals.md', 'package/lib/review-contract/index.js'].join(
          '\n',
        ),
      ),
    ).toEqual([]);
  });

  it('ignores blank lines rather than reporting them', () => {
    expect(forbiddenEntries('package/lib/index.js\n\n')).toEqual([]);
  });
});

describe('shipped module imports', () => {
  it('accepts modules that import only production code', () => {
    expect(
      evalsSpecifiers(
        [
          "import { scoreReview } from './review-contract/matrix.js';",
          "export { evaluateReview } from './review-contract/evaluate.js';",
          "const loaded = await import('./rules/match.js');",
        ].join('\n'),
      ),
    ).toEqual([]);
  });

  it('catches a static import that reaches into evals', () => {
    expect(
      evalsSpecifiers("import { run } from '../evals/src/cli/run.js';"),
    ).toEqual(['../evals/src/cli/run.js']);
  });

  it('catches a dynamic import and a require that reach into evals', () => {
    expect(
      evalsSpecifiers("const cli = await import('../evals/src/cli.ts');"),
    ).toEqual(['../evals/src/cli.ts']);
    expect(
      evalsSpecifiers("const data = require('../evals/src/data/read.ts');"),
    ).toEqual(['../evals/src/data/read.ts']);
  });

  it('catches a bare specifier that resolves to evals', () => {
    expect(evalsSpecifiers("import x from 'evals/src/data/hash.js';")).toEqual([
      'evals/src/data/hash.js',
    ]);
  });

  it('does not treat an unrelated package whose name contains evals as a match', () => {
    expect(evalsSpecifiers("import tune from 'evalscript';")).toEqual([]);
  });
});
