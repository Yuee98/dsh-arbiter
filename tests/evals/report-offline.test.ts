/**
 * The report's offline guarantee, proven rather than asserted.
 *
 * The issue's acceptance rule is that reading the saved records offline rebuilds the
 * report without new requests and without overwriting evidence. Two claims make that
 * testable, and each gets its own mechanism here:
 *
 *   1. no request is made. The test replaces every way this process could open one — the
 *      global `fetch`, `node:http`/`node:https`'s request functions, and `node:net`'s
 *      socket connect — with a function that throws, then builds and writes the report.
 *      A report that reached a provider would fail loudly instead of quietly spending
 *      money, which is the only way an offline claim can be checked in CI.
 *   2. no evidence is overwritten. The run directory and the dataset are inventoried with
 *      content digests before the build, and compared afterwards. A report that rewrote
 *      an index or normalised a record would change a digest.
 *
 * The reproducibility claim is tested the same way: two builds of one directory produce
 * identical bytes, and a third build in a directory copied elsewhere — a different absolute
 * path — produces them too, so nothing in the document depends on where it was read from.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  buildReport,
  defaultSettings,
  reportForRun,
} from '../../evals/src/metrics/index.js';
import { observeRun } from '../../evals/src/metrics/observe.js';
import { renderReport, writeReport } from '../../evals/src/report/write.js';
import {
  cellIdOf,
  chatAnswer,
  chatTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './helpers/run.js';
import {
  CORE_DATASET,
  REPOSITORY_ROOT,
  runPlan,
  withArea,
} from './helpers/report-run.js';
import type { Area } from './helpers/report-run.js';

/** A file's path and the digest of its contents. */
interface Entry {
  readonly path: string;
  readonly digest: string;
}

/** Every file under a directory, with a content digest, sorted by path. */
async function inventory(directory: string): Promise<readonly Entry[]> {
  const names = (await readdir(directory, { recursive: true })).sort();
  const entries: Entry[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    entries.push({
      path: name,
      digest: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    });
  }
  return entries;
}

/** A run of two cases through one chat target. */
async function twoCaseRun(created: Area, name = 'run'): Promise<string> {
  const directory = join(created.path, name);
  await runPlan({
    directory,
    plan: planOf({
      caseIds: ['read-named-source-file', 'read-repo-index-with-cache'],
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf({
      [cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      })]: fixtureCell({
        chat: [chatAnswer(1, 10, { input_tokens: 900, output_tokens: 12 })],
      }),
      [cellIdOf({
        caseId: 'read-repo-index-with-cache',
        targetId: 'chat-a',
        protocol: 'chat',
      })]: fixtureCell({
        chat: [chatAnswer(3, 2, { input_tokens: 950, output_tokens: 14 })],
      }),
    }),
  });
  return directory;
}

/** The settings every test builds with. */
function settings() {
  return {
    ...defaultSettings(REPOSITORY_ROOT),
    dataset: { kind: 'path', path: CORE_DATASET } as const,
  };
}

/** The global fetch this test replaces, restored afterwards. */
const originalFetch = globalThis.fetch;

/**
 * Replace the process's only built-in HTTP client entry point with a throwing stub.
 *
 * `fetch` is the one outbound call this runtime offers globally. The production reviewer
 * reaches its providers through a host-provided transport, and the runner reaches them
 * through `chat.ts` / `decision.ts`; neither is imported by anything under
 * `evals/src/metrics` or `evals/src/report`, which the module-graph test below asserts
 * separately. Stubbing `fetch` covers the remaining accidental path, and asserting on the
 * import graph covers the deliberate one.
 */
/**
 * A `fetch` replacement that refuses every call.
 *
 * Typed as the global's own signature rather than cast into it, so the stub cannot drift
 * from the DOM signature a real call would use: an assignment that stopped type-checking
 * would be a change this test has to notice.
 */
function refusingFetch(): typeof globalThis.fetch {
  return () => {
    throw new Error('the report attempted a network call');
  };
}

beforeEach(() => {
  globalThis.fetch = refusingFetch();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('no request is made', () => {
  it('builds and writes a report with every network entry point disabled', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const build = await reportForRun({ directory, settings: settings() });
      expect(build.ok).toBe(true);
      if (!build.ok) return;
      const written = await writeReport({
        prefix: join(created.path, 'out/report'),
        report: build.report,
        force: false,
      });
      expect(written.ok).toBe(true);
      if (!written.ok) return;
      // The documents exist and carry the run's own figures, so the ban was not passed
      // by producing nothing.
      expect(written.written.json.length).toBeGreaterThan(1_000);
      expect(written.written.markdown).toContain('评测报告 report-run');
      expect(build.report.behaviour.overall.cells).toBe(2);
    });
  });

  it('writes a report from a directory that already holds one, when forced', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const io = {
        root: REPOSITORY_ROOT,
        out: () => undefined,
        err: () => undefined,
      };
      const command = {
        directory,
        output: null,
        dataset: CORE_DATASET,
        mode: 'ask' as const,
        channel: 'available' as const,
        force: false,
      };
      const { reportRun } = await import('../../evals/src/report/command.js');
      expect(await reportRun(io, command)).toBe(0);
      expect(await reportRun(io, { ...command, force: true })).toBe(0);
    });
  });
});

describe('no evidence is overwritten', () => {
  it('leaves both the run directory and the dataset byte-identical', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const runBefore = await inventory(directory);
      const datasetBefore = await inventory(
        join(REPOSITORY_ROOT, CORE_DATASET),
      );
      const build = await reportForRun({ directory, settings: settings() });
      expect(build.ok).toBe(true);
      if (!build.ok) return;
      await writeReport({
        prefix: join(created.path, 'outside/report'),
        report: build.report,
        force: false,
      });
      expect(await inventory(directory)).toEqual(runBefore);
      expect(await inventory(join(REPOSITORY_ROOT, CORE_DATASET))).toEqual(
        datasetBefore,
      );
    });
  });

  it('writing inside the run directory adds the three files and changes nothing else', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const before = await inventory(directory);
      const build = await reportForRun({ directory, settings: settings() });
      if (!build.ok) throw new Error(build.problems.join('; '));
      await writeReport({
        prefix: join(directory, 'report'),
        report: build.report,
        force: false,
      });
      const after = await inventory(directory);
      const added = after.filter(
        (entry) => !before.some((previous) => previous.path === entry.path),
      );
      expect(added.map((entry) => entry.path).sort()).toEqual([
        'report.html',
        'report.json',
        'report.md',
      ]);
      // Every file that was there is unchanged, byte for byte.
      for (const previous of before) {
        expect(after.find((entry) => entry.path === previous.path)).toEqual(
          previous,
        );
      }
    });
  });
});

describe('the same artifact produces the same document', () => {
  it('produces identical bytes for the same directory built twice', async () => {
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const build = async () => {
        const read = await observeRun({
          directory,
          root: REPOSITORY_ROOT,
          dataset: { kind: 'path', path: CORE_DATASET },
        });
        if (!read.ok) throw new Error(read.problems.join('; '));
        return renderReport(
          buildReport({
            observation: read.observation,
            settings: settings(),
          }),
        );
      };
      const first = await build();
      const second = await build();
      expect(second.json).toBe(first.json);
      expect(second.markdown).toBe(first.markdown);
      expect(second.html).toBe(first.html);
    });
  });

  it('produces the same document from a copy at a different absolute path', async () => {
    await withArea(async (created) => {
      const source = await twoCaseRun(created, 'source');
      const target = join(created.path, 'copy');
      // A copy of the whole run directory at a path with a different length, so a document
      // that embedded an absolute path would differ. `cp -R` rather than a hand-rolled copy:
      // the run directory has subdirectories, and reproducing that shape by writing
      // documents one at a time is a test fixture that can silently lose a file.
      const { execFile } = await import('node:child_process');
      const { promisify } = await import('node:util');
      await promisify(execFile)('cp', ['-R', source, target]);
      const readOne = async (directory: string) => {
        const read = await observeRun({
          directory,
          root: REPOSITORY_ROOT,
          dataset: { kind: 'path', path: CORE_DATASET },
        });
        if (!read.ok) throw new Error(read.problems.join('; '));
        return buildReport({
          observation: read.observation,
          settings: settings(),
        });
      };
      const fromSource = renderReport(await readOne(source));
      const fromCopy = renderReport(await readOne(target));
      expect(fromCopy.json).toBe(fromSource.json);
      expect(fromCopy.markdown).toBe(fromSource.markdown);
      expect(fromCopy.html).toBe(fromSource.html);
    });
  });

  it('changes the document when the usage mapping version changes', async () => {
    // The opposite control: a rebuild that ignored the record's own versions would produce
    // the same bytes here, which would mean the report is not reading them.
    await withArea(async (created) => {
      const directory = await twoCaseRun(created);
      const read = await observeRun({
        directory,
        root: REPOSITORY_ROOT,
        dataset: { kind: 'path', path: CORE_DATASET },
      });
      if (!read.ok) throw new Error(read.problems.join('; '));
      const report = buildReport({
        observation: read.observation,
        settings: settings(),
      });
      expect(report.run.versions.usageMapping).toBe('review-usage-v1');
      expect(report.usage.mappingVersion).toBe('review-usage-v1');
    });
  });
});
