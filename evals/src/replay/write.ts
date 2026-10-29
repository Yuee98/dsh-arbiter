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

import { mkdir, stat, writeFile } from 'node:fs/promises';
import { join, posix, resolve } from 'node:path';

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
 * A separator boundary is what keeps `/runs/a` from protecting `/runs/ab`, and
 * resolution is what makes the comparison independent of how the caller spelled the
 * two paths.
 */
function overlaps(inner: string, outer: string): boolean {
  const left = resolve(inner);
  const right = resolve(outer);
  return left === right || left.startsWith(`${right}${posix.sep}`);
}

/**
 * Whether this destination would write into, over, or around the evidence.
 *
 * Both directions are refused. Writing below the source would add documents to the
 * run being replayed; writing above it would make the derived directory contain the
 * source, so a report of the derivation would describe the original's records too.
 * An ordinary sibling is what is allowed, and it is the normal case.
 */
export function destinationRefusal(parts: {
  readonly source: string;
  readonly destination: string;
}): string | null {
  if (overlaps(parts.destination, parts.source)) {
    return `${parts.destination} lies inside the run being replayed (${parts.source}); a replay never writes into its own evidence`;
  }
  if (overlaps(parts.source, parts.destination)) {
    return `${parts.destination} contains the run being replayed (${parts.source}); a derived run must not be written over its source`;
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
 * Write one derivation, its lineage and its report.
 *
 * The order is the order a reader needs: the run documents first, so the report can
 * be built by reading them, and the lineage last, because it names the report files
 * the derivation produced. A failure at any point before the lineage leaves a
 * directory with no lineage — which is precisely a directory a reader must not
 * mistake for a finished derivation, and it is what `--force` exists to replace.
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
  const conflict = destinationRefusal({
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

/** A path as the lineage prints it: relative to the directory it describes. */
function relativeTo(directory: string, path: string): string {
  const base = `${directory}/`;
  return path.startsWith(base) ? path.slice(base.length) : path;
}

/** Where one variant's directory lives when the caller named a parent. */
export function variantDirectoryOf(parent: string, variantId: string): string {
  return join(parent, variantId);
}
