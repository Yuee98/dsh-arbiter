/**
 * The module graph the report is allowed to have.
 *
 * The behavioral test in `report-offline.test.ts` proves no request is made by the code
 * that ran. This file proves the stronger structural claim the issue actually rests on:
 * the report's modules *cannot* reach a transport, because they import none. A behavioral
 * stub only covers the paths a test happens to execute; an import-graph rule covers every
 * path there is, including the ones a future edit would add.
 *
 * Three things are forbidden, and each has its own reason:
 *
 *   - the runner's executor, scheduler and lifecycle. Those are what dispatch, bound and
 *     write, and a report that imported one could start a run from a read command.
 *   - the production reviewer's service and protocol adapters. Those are what call a
 *     provider; a report that imported one could make a request without the runner.
 *   - the fixture reader. Replaying a fixture is a run, not a report.
 *
 * The allowed set is not empty: the shared review contract, the shared usage mapping, the
 * artifact reader, the schema checkers and the dataset readers are exactly the interfaces
 * a report is supposed to consume.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPOSITORY_ROOT } from './helpers/report-run.js';

/** The directories that make up the report implementation. */
const REPORT_DIRECTORIES = ['evals/src/metrics', 'evals/src/report'];

/**
 * Specifiers a report module may not import, as path fragments.
 *
 * Expressed as fragments rather than exact paths so a new file in one of those areas is
 * covered without the test having to be updated: the rule is about the area, not about a
 * filename that happens to exist today.
 */
const FORBIDDEN = [
  // The runner's executable half.
  '/run/execute',
  '/run/scheduler',
  '/run/lifecycle',
  '/run/commands',
  '/run/material',
  '/run/plan',
  // The production reviewer's transport half.
  '/reviewer/service',
  '/reviewer/chat',
  '/reviewer/decision',
  '/reviewer/backends',
  '/reviewer/redact',
  // Anything under a transport or backend directory.
  '/backends/',
  '/transport',
] as const;

/** Paths a report must not name even as a string, because a dynamic import would hide it. */
const FORBIDDEN_TEXT = [
  'fetch(',
  'node:http',
  'node:https',
  'node:net',
] as const;

/** Every `.ts` file under one directory, recursively. */
async function typescriptFiles(directory: string): Promise<readonly string[]> {
  const found: string[] = [];
  for (const name of await readdir(join(REPOSITORY_ROOT, directory), {
    recursive: true,
  })) {
    if (name.endsWith('.ts'))
      found.push(posix.join(directory, name.split('\\').join('/')));
  }
  return found.sort();
}

/** Every module specifier a source text names, from a static or dynamic import. */
function specifiersOf(text: string): readonly string[] {
  const specifiers: string[] = [];
  const patterns = [
    /(?:^|\n)\s*(?:import|export)[^'"]*?from\s*['"]([^'"]+)['"]/gu,
    /(?:^|\n)\s*import\s+['"]([^'"]+)['"]/gu,
    /import\(\s*['"]([^'"]+)['"]\s*\)/gu,
    /require\(\s*['"]([^'"]+)['"]\s*\)/gu,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const specifier = match[1];
      if (specifier !== undefined) specifiers.push(specifier);
    }
  }
  return specifiers;
}

/** The repository-relative path a relative specifier resolves to. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return posix.normalize(posix.join(posix.dirname(from), specifier));
}

/**
 * Every repository path the report's own files import, resolved and normalised.
 *
 * Asserting on resolved paths rather than on the specifier text is what makes these checks
 * depth-independent: a section module two directories deeper writes `../../../src/...`
 * where the metrics root writes `../../src/...`, and both must satisfy the same rule.
 */
async function resolvedImports(): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const { file, specifier } of await reportImports()) {
    const path = resolveSpecifier(file, specifier);
    if (path === null) continue;
    resolved.push(path.replace(/\.js$/u, '.ts'));
  }
  return [...new Set(resolved)].sort();
}

/** Every module specifier the report's own files name. */
async function reportImports(): Promise<
  readonly { readonly file: string; readonly specifier: string }[]
> {
  const imports: { file: string; specifier: string }[] = [];
  for (const directory of REPORT_DIRECTORIES) {
    for (const file of await typescriptFiles(directory)) {
      const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
      for (const specifier of specifiersOf(text)) {
        imports.push({ file, specifier });
      }
    }
  }
  return imports;
}

describe('the report cannot reach a transport', () => {
  it('imports no executor, scheduler, lifecycle or transport module', async () => {
    const offenders: string[] = [];
    for (const { file, specifier } of await reportImports()) {
      const resolved = resolveSpecifier(file, specifier) ?? specifier;
      for (const forbidden of FORBIDDEN) {
        if (resolved.includes(forbidden)) {
          offenders.push(`${file} -> ${specifier}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('names no HTTP client or socket module anywhere in its source', async () => {
    const offenders: string[] = [];
    for (const directory of REPORT_DIRECTORIES) {
      for (const file of await typescriptFiles(directory)) {
        const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
        for (const needle of FORBIDDEN_TEXT) {
          if (text.includes(needle)) offenders.push(`${file} names ${needle}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('consumes the published artifact reader rather than the directory layout', async () => {
    // The positive half of the same rule: the report must import the consumer interface,
    // because a report that walked `records/` itself would be coupled to a format detail
    // the reader exists to hide.
    expect(await resolvedImports()).toContain('evals/src/run/artifact.ts');
  });

  it('imports the shared usage mapping rather than restating the field table', async () => {
    expect(await resolvedImports()).toContain('src/reviewer/usage.ts');
    // No report module may define its own mapping version constant or bucket list: both
    // belong to the shared contract, and a second copy would drift.
    for (const directory of REPORT_DIRECTORIES) {
      for (const file of await typescriptFiles(directory)) {
        const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
        expect(text).not.toContain("'review-usage-v1'");
      }
    }
  });

  it('imports the shared settlement rule rather than restating the matrix', async () => {
    // The matrix belongs to `src/review-contract`. A report that reimplemented it could
    // disagree with the reviewer it is measuring, which is the one thing a settlement
    // layer must not do.
    expect(await resolvedImports()).toContain('src/review-contract/matrix.ts');
    for (const directory of REPORT_DIRECTORIES) {
      for (const file of await typescriptFiles(directory)) {
        const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
        // A literal threshold table would show up as the matrix's own band boundaries;
        // the report may print a score pair, never decide with one.
        expect(text).not.toMatch(
          /requiredAuthorizationFor\s*=|AUTHORIZATION_BANDS\s*=/u,
        );
      }
    }
  });
});
