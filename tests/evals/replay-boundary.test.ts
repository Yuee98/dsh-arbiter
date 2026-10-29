/**
 * The module graph a replay is allowed to have.
 *
 * The behavioural test in `replay-offline.test.ts` proves no request is made by the
 * code that ran. This file proves the stronger structural claim: `evals/src/replay`
 * *cannot* reach a transport or a dispatcher, because it imports none. A behavioural
 * stub only covers the paths a test happens to execute; an import-graph rule covers
 * every path there is, including ones a future edit would add.
 *
 * Three things are forbidden, and each has its own reason:
 *
 *   - the runner's executor, scheduler, lifecycle, plan and material modules. Those
 *     are what dispatch and bound a run, and a replayer that imported one could start
 *     a run from a read command.
 *   - the production reviewer's service and protocol adapters. Those are what call a
 *     provider; a replayer that imported one could make a request.
 *   - the fixture runner. Replaying a scripted socket is a run, not a replay.
 *
 * The allowed set is not empty: the shared contract, the adapters' own answer readers,
 * the artifact reader and the report layer are exactly the interfaces a replay is
 * supposed to consume. In particular, `src/review-contract/normalize.ts` and
 * `src/reviewer/signals.ts` are required rather than merely allowed — a replay that
 * restated N0 or the answer shape would be the second implementation this feature
 * exists to avoid.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join, posix } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPOSITORY_ROOT } from './helpers/report-run.js';

/** The directory that makes up the replay implementation. */
const REPLAY_DIRECTORY = 'evals/src/replay';

/** Specifiers a replay module may not import, as path fragments. */
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
  '/reviewer/offline',
  // Anything under a transport or backend directory.
  '/backends/',
  '/transport',
] as const;

/** Text a replay module must not name, because a dynamic import would hide it. */
const FORBIDDEN_TEXT = [
  'fetch(',
  'node:http',
  'node:https',
  'node:net',
] as const;

/** Every `.ts` file under the replay directory, as repository-relative paths. */
async function replayFiles(): Promise<readonly string[]> {
  const found: string[] = [];
  for (const name of await readdir(join(REPOSITORY_ROOT, REPLAY_DIRECTORY), {
    recursive: true,
  })) {
    if (name.endsWith('.ts')) {
      found.push(posix.join(REPLAY_DIRECTORY, name.split('\\').join('/')));
    }
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

/** Every specifier the replay's files name, with the file that named it. */
async function replayImports(): Promise<
  readonly { readonly file: string; readonly specifier: string }[]
> {
  const imports: { file: string; specifier: string }[] = [];
  for (const file of await replayFiles()) {
    const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
    for (const specifier of specifiersOf(text)) {
      imports.push({ file, specifier });
    }
  }
  return imports;
}

/** The repository path a relative specifier resolves to, or null. */
function resolveSpecifier(from: string, specifier: string): string | null {
  if (!specifier.startsWith('.')) return null;
  return posix
    .normalize(posix.join(posix.dirname(from), specifier))
    .replace(/\.js$/u, '.ts');
}

/** Every repository path the replay's files import, resolved and normalised. */
async function resolvedImports(): Promise<readonly string[]> {
  const resolved: string[] = [];
  for (const { file, specifier } of await replayImports()) {
    const path = resolveSpecifier(file, specifier);
    if (path !== null) resolved.push(path);
  }
  return [...new Set(resolved)].sort();
}

describe('a replay cannot reach a transport', () => {
  it('imports no executor, scheduler, lifecycle or transport module', async () => {
    const offenders: string[] = [];
    for (const { file, specifier } of await replayImports()) {
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
    for (const file of await replayFiles()) {
      const text = await readFile(join(REPOSITORY_ROOT, file), 'utf8');
      for (const needle of FORBIDDEN_TEXT) {
        if (text.includes(needle)) offenders.push(`${file} names ${needle}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});

describe('a replay re-uses the shared semantics rather than restating them', () => {
  it('calls the shared N0 comparison and the shared matrix', async () => {
    const imports = await resolvedImports();
    expect(imports).toContain('src/review-contract/index.ts');
    // The comparison itself: `bandFrom` is imported by name, so the cumulative sum and
    // the exact-half rule are production's and not a copy.
    const derive = await readFile(
      join(REPOSITORY_ROOT, REPLAY_DIRECTORY, 'derive.ts'),
      'utf8',
    );
    expect(derive).toContain('bandFrom(');
    expect(derive).toContain('scoreReview(');
    expect(derive).toContain('evaluateReview(');
    expect(derive).toContain('materialAvailability(');
    // None of these may be re-defined here. A local `requiredAuthorizationFor` would be
    // a second matrix; a local cumulative sum would be a second N0.
    expect(derive).not.toMatch(/function\s+requiredAuthorizationFor/u);
    expect(derive).not.toMatch(/function\s+cumulative/u);
    expect(derive).not.toMatch(/function\s+bandFrom/u);
  });

  it('reads answers with the adapters own parsers', async () => {
    const derive = await readFile(
      join(REPOSITORY_ROOT, REPLAY_DIRECTORY, 'derive.ts'),
      'utf8',
    );
    expect(derive).toContain("from '../../../src/reviewer/signals.js'");
    expect(derive).toContain('readChatAnswer');
    expect(derive).toContain('readDecisionAnswer');
  });

  it('builds each report through the report layer rather than rendering one itself', async () => {
    const write = await readFile(
      join(REPOSITORY_ROOT, REPLAY_DIRECTORY, 'write.ts'),
      'utf8',
    );
    // The report is built by reading the derived directory back, so the derived
    // documents go through the same reader a report always uses.
    expect(write).toContain('reportForRun(');
    expect(write).toContain('writeReport(');
    // And nothing here renders HTML, Markdown or JSON itself.
    expect(write).not.toContain('renderMarkdown(');
    expect(write).not.toContain('renderHtml(');
    expect(write).not.toContain('<html');
  });

  it('reads the run directory through the published consumer interface', async () => {
    const imports = await resolvedImports();
    expect(imports).toContain('evals/src/run/artifact.ts');
    expect(imports).toContain('evals/src/run/schemas.ts');
    // A replayer that walked `records/` itself would be coupled to a layout detail the
    // reader exists to hide.
    const source = await readFile(
      join(REPOSITORY_ROOT, REPLAY_DIRECTORY, 'source.ts'),
      'utf8',
    );
    expect(source).toContain('readRun(');
    expect(source).not.toContain("'records/'");
  });
});
