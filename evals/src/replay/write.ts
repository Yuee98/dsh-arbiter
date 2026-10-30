/**
 * Writing one derivation to its own directory.
 *
 * A derived run is a run directory: the same four documents a report already knows
 * how to read, plus the lineage that says where they came from. That choice is
 * what lets the report layer be reused unchanged — `observeRun` and `buildReport`
 * read the derived directory exactly as they read an original one — and it is also
 * what makes the "the source was not touched" claim checkable, because the derived
 * run cannot be the source's directory.
 *
 * Four guarantees are enforced here rather than described:
 *
 *   - **the source is never written.** The derived directory may not resolve inside
 *     the source directory, may not equal it, and may not contain it.
 *   - **nothing is written that the published schemas reject.** Every derived
 *     document is narrowed by the same checkers the reader uses, before the first
 *     byte is written. A derivation that produced a document this build's own
 *     reader would refuse is a defect in the replayer, and finding it here keeps it
 *     from becoming a directory nobody can report on.
 *   - **an existing derivation is not replaced without `--force`.** A derivation is
 *     evidence of what a threshold would have produced, and silently replacing one
 *     is exactly how two people compare different experiments under one name.
 *   - **the report is built by reading the directory back.** Building it from the
 *     in-memory documents would be faster and would prove less: the claim is that
 *     the derived directory is readable as a run, and only a read establishes that.
 */

import {
  mkdir,
  mkdtemp,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';

import { reportForRun } from '../metrics/index.js';
import type { ReportSettings } from '../metrics/types.js';
import {
  defaultPrefixOf,
  reportPathsOf,
  writeReport,
} from '../report/write.js';
import type { EvidencePath } from '../report/write.js';
import { RUN_FILES, writeJson } from '../run/artifact.js';
import { compileRunCheckers } from '../run/schemas.js';

import type { Derivation } from './assemble.js';
import { pathOfDerivedRecord } from './assemble.js';

/**
 * The prefix of a staging directory.
 *
 * A dot-prefixed name keeps it out of the way of anyone listing the parent, and the
 * suffix `mkdtemp` adds makes it unique, so two concurrent replays cannot collide.
 */
const STAGING_PREFIX = '.replay-staging-';

/** Documents a derived directory carries beside the run's own. */
export const REPLAY_FILES = {
  /** What one derived directory says about its own derivation. */
  lineage: 'lineage.json',
} as const;

/** A write that produced a derived directory. */
export interface DerivedWrite {
  readonly directory: string;
  readonly runId: string;
  /** The report files, relative to the derived directory. */
  readonly report: readonly string[];
  readonly records: number;
}

/** Why a write was refused. */
export interface WriteRefusal {
  readonly ok: false;
  readonly problems: readonly string[];
}

/** Whether a path exists at all. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Whether one path is the other, or lies beneath it.
 *
 * Two details carry this comparison, and getting either wrong opens the evidence to
 * a write:
 *
 *   - the separator comes from `sep`, not from a literal `/`. On Windows a resolved
 *     path uses `\`, so a `/` test never matches and a nested destination looks
 *     unrelated. The boundary check is what keeps `/runs/a` from protecting
 *     `/runs/ab`, so it has to be the platform's own separator.
 *   - both sides are compared after canonicalisation, because `resolve()` only
 *     normalises spelling. A destination that reaches the source through a symbolic
 *     link — `out/<variant>` linked to the run, or a linked parent — is lexically
 *     elsewhere and physically inside it.
 */
function overlaps(inner: string, outer: string): boolean {
  const left = resolve(inner);
  const right = resolve(outer);
  return left === right || left.startsWith(`${right}${sep}`);
}

/**
 * The real location of a path whose leaf may not exist yet.
 *
 * `realpath` refuses a missing path, and a destination is normally missing before the
 * first write. So the deepest existing ancestor is canonicalised and the components
 * below it are re-appended: every link that exists is followed, and the part that does
 * not exist yet cannot be a link. Without this the check would either have to fail
 * open on every new destination or refuse the ordinary case.
 */
async function canonical(path: string): Promise<string> {
  const tail: string[] = [];
  let current = resolve(path);
  for (;;) {
    try {
      const real = await realpath(current);
      return tail.length === 0 ? real : join(real, ...tail.reverse());
    } catch {
      const parent = dirname(current);
      // At the filesystem root there is nothing left to canonicalise; the resolved
      // path is the best available answer, and it is exact because every component
      // above it was already tried.
      if (parent === current) return resolve(path);
      tail.push(basename(current));
      current = parent;
    }
  }
}

/**
 * Whether this destination would write into, over, or around the evidence.
 *
 * Both directions are refused. Writing below the source would add documents to the
 * run being replayed; writing above it would make the derived directory contain the
 * source, so a report of the derivation would describe the original's records too.
 * An ordinary sibling is what is allowed, and it is the normal case.
 *
 * This is the guard that makes "the source is never written" true rather than
 * intended, so it compares real locations rather than spelled ones. It runs before
 * every write and cannot be bypassed by `--force`: force decides whether an existing
 * derivation may be replaced, never whether the evidence may be.
 */
export async function destinationRefusal(parts: {
  readonly source: string;
  readonly destination: string;
}): Promise<string | null> {
  const source = await canonical(parts.source);
  const destination = await canonical(parts.destination);
  if (overlaps(destination, source)) {
    return `${parts.destination} resolves inside the run being replayed (${source}); a replay never writes into its own evidence`;
  }
  if (overlaps(source, destination)) {
    return `${parts.destination} resolves to a directory that contains the run being replayed (${source}); a derived run must not be written over its source`;
  }
  return null;
}

/** The evidence a derived run's own report may not overwrite. */
function protectedEvidenceOf(directory: string): readonly EvidencePath[] {
  return [
    { path: join(directory, RUN_FILES.plan), kind: 'file' },
    { path: join(directory, RUN_FILES.index), kind: 'file' },
    { path: join(directory, RUN_FILES.fixture), kind: 'file' },
    { path: join(directory, REPLAY_FILES.lineage), kind: 'file' },
    { path: join(directory, RUN_FILES.records), kind: 'directory' },
  ];
}

/**
 * Check every derived document against the published schemas.
 *
 * These are the same checkers `readRun` uses, which is the point: a derivation that
 * cannot be read back is not a derivation, and a schema failure is this build's
 * mistake rather than the caller's. The messages name the cell, so a defect points
 * at the record that produced it.
 */
async function documentProblems(derivation: Derivation): Promise<string[]> {
  const checkers = await compileRunCheckers();
  const problems: string[] = [];
  const plan = checkers.plan(derivation.run.plan);
  if (!plan.ok) {
    problems.push(`${RUN_FILES.plan}: ${plan.problems.join('; ')}`);
  }
  const index = checkers.index(derivation.run.index);
  if (!index.ok) {
    problems.push(`${RUN_FILES.index}: ${index.problems.join('; ')}`);
  }
  for (const record of derivation.run.records) {
    const checked = checkers.record(record);
    if (!checked.ok) {
      problems.push(
        `${pathOfDerivedRecord(record)}: ${checked.problems.join('; ')}`,
      );
    }
  }
  return problems;
}

/**
 * A fresh directory no pre-existing entry can occupy.
 *
 * `mkdtemp` creates the leaf and guarantees nobody else chose it, so every descendant
 * below it is one this process creates. That is the whole reason a staging directory is
 * used rather than writing the destination directly: a destination can already contain
 * a `records/` directory that is a symbolic link into the run being replayed, and a
 * write through it would corrupt the evidence whatever the top-level check said. A
 * directory that did not exist a moment ago cannot contain such a link.
 */
async function stagingDirectory(parent: string): Promise<string> {
  await mkdir(parent, { recursive: true });
  return mkdtemp(join(parent, STAGING_PREFIX));
}

/**
 * Move a finished staging directory into place.
 *
 * A destination that already exists is replaced only when the caller asked for it, and
 * the removal is `rm`, which unlinks symbolic links rather than following them: the one
 * operation that must never happen here is a write through a link that points at the
 * evidence. `rename` then publishes the whole derivation at once, so a reader never
 * observes a partially written directory.
 */
async function publish(parts: {
  readonly staging: string;
  readonly destination: string;
}): Promise<void> {
  await mkdir(dirname(parts.destination), { recursive: true });
  await rename(parts.staging, parts.destination);
}

/**
 * Write one derivation, its lineage and its report.
 *
 * The derivation is built inside a staging directory and published with one rename.
 * That ordering is what makes the "the source is never written" claim hold for every
 * path a write can reach, not only for the top-level directory: the files this function
 * writes are only ever written below a directory it just created, so no pre-existing
 * symbolic link can redirect one of them into the run being replayed.
 *
 * The order inside the staging directory is the order a reader needs: the run documents
 * first, so the report can be built by reading them, and the lineage last, because it
 * names the report files the derivation produced.
 */
export async function writeDerivation(parts: {
  readonly derivation: Derivation;
  readonly directory: string;
  readonly settings: ReportSettings;
  readonly force: boolean;
  readonly sourceDirectory: string;
}): Promise<
  { readonly ok: true; readonly written: DerivedWrite } | WriteRefusal
> {
  const conflict = await destinationRefusal({
    source: parts.sourceDirectory,
    destination: parts.directory,
  });
  if (conflict !== null) return { ok: false, problems: [conflict] };
  if (!parts.force) {
    const conflicts = await Promise.all(
      writablePaths(parts.derivation, parts.directory).map(async (path) =>
        (await exists(path)) ? path : null,
      ),
    );
    const found = conflicts.filter((path): path is string => path !== null);
    if (found.length > 0) {
      return {
        ok: false,
        problems: found.map(
          (path) =>
            `${path} already exists; a derivation is evidence, so it is not overwritten without --force`,
        ),
      };
    }
  }
  const problems = await documentProblems(parts.derivation);
  if (problems.length > 0) return { ok: false, problems };
  const staging = await stagingDirectory(dirname(parts.directory));
  // The staging directory itself could land inside the source when the caller named a
  // parent that is a link into it; the check runs on the real location of the directory
  // that is about to receive the writes.
  const staged = await destinationRefusal({
    source: parts.sourceDirectory,
    destination: staging,
  });
  if (staged !== null) {
    await rm(staging, { recursive: true, force: true });
    return { ok: false, problems: [staged] };
  }
  try {
    const written = await fill({
      derivation: parts.derivation,
      directory: staging,
      settings: parts.settings,
      force: true,
    });
    if (!written.ok) {
      await rm(staging, { recursive: true, force: true });
      return written;
    }
    // A destination that already exists is replaced only on an explicit `--force`, and
    // the replacement removes the old tree instead of writing into it: `rm` unlinks a
    // symbolic link rather than following it, which is the one operation that must never
    // happen next to the evidence.
    if (await exists(parts.directory)) {
      if (!parts.force) {
        await rm(staging, { recursive: true, force: true });
        return {
          ok: false,
          problems: [
            `${parts.directory} already exists; a derivation is evidence, so it is not overwritten without --force`,
          ],
        };
      }
      await rm(parts.directory, { recursive: true, force: true });
    }
    await publish({ staging, destination: parts.directory });
    return {
      ok: true,
      written: { ...written.written, directory: parts.directory },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
}

/** Write the derivation's documents into a directory that is already this process's. */
async function fill(parts: {
  readonly derivation: Derivation;
  readonly directory: string;
  readonly settings: ReportSettings;
  readonly force: boolean;
}): Promise<
  { readonly ok: true; readonly written: DerivedWrite } | WriteRefusal
> {
  await mkdir(join(parts.directory, RUN_FILES.records), { recursive: true });
  await writeJson(
    join(parts.directory, RUN_FILES.plan),
    parts.derivation.run.plan,
  );
  await writeJson(
    join(parts.directory, RUN_FILES.index),
    parts.derivation.run.index,
  );
  for (const record of parts.derivation.run.records) {
    await writeJson(join(parts.directory, pathOfDerivedRecord(record)), record);
  }
  const fixture = parts.derivation.run.fixture;
  if (fixture !== null) {
    // Byte for byte, because the derived index repeats the source's fixture digest:
    // re-serialising the document would change those bytes and make the digest a
    // claim about a different file.
    await writeFile(join(parts.directory, RUN_FILES.fixture), fixture);
  }
  const prefix = defaultPrefixOf(parts.directory);
  const read = await reportForRun({
    directory: parts.directory,
    settings: parts.settings,
  });
  if (!read.ok) {
    return {
      ok: false,
      problems: read.problems.map(
        (problem) => `the derived run could not be reported: ${problem}`,
      ),
    };
  }
  const report = await writeReport({
    prefix,
    report: read.report,
    force: parts.force,
    protectedEvidence: protectedEvidenceOf(parts.directory),
  });
  if (!report.ok) return { ok: false, problems: report.problems };
  // Listed in the writer's own member order rather than a directory listing, so two
  // derivations of one variant produce the same lineage bytes.
  const reportFiles = [
    reportPathsOf(prefix).json,
    reportPathsOf(prefix).markdown,
    reportPathsOf(prefix).html,
  ].map((path) => relativeTo(parts.directory, path));
  await writeJson(join(parts.directory, REPLAY_FILES.lineage), {
    ...parts.derivation.lineage,
    derived: {
      ...parts.derivation.lineage.derived,
      report: reportFiles,
    },
  });
  return {
    ok: true,
    written: {
      directory: parts.directory,
      runId: parts.derivation.run.runId,
      report: reportFiles,
      records: parts.derivation.run.records.length,
    },
  };
}

/** Every file a derivation would create, so a conflict can be found first. */
function writablePaths(
  derivation: Derivation,
  directory: string,
): readonly string[] {
  return [
    join(directory, RUN_FILES.plan),
    join(directory, RUN_FILES.index),
    join(directory, REPLAY_FILES.lineage),
    ...derivation.run.records.map((record) =>
      join(directory, pathOfDerivedRecord(record)),
    ),
    ...Object.values(reportPathsOf(defaultPrefixOf(directory))),
  ];
}

/**
 * A path as the lineage prints it: relative to the directory it describes.
 *
 * `relative` rather than a string prefix, so the result is correct where the platform
 * separator is not `/`. A lineage that printed an absolute path here would make two
 * derivations of one variant differ just because they were written elsewhere.
 */
function relativeTo(directory: string, path: string): string {
  const relativePath = relative(directory, path);
  return relativePath.startsWith('..') ? path : relativePath;
}

/** Where one variant's directory lives when the caller named a parent. */
export function variantDirectoryOf(parent: string, variantId: string): string {
  return join(parent, variantId);
}
