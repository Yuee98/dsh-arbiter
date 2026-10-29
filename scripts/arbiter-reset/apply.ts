/**
 * The only place this repository deletes audit data.
 *
 * Three properties make a deletion safe to hand to an operator:
 *
 * 1. **Nothing is deleted from a plan the operator did not confirm.** The plan
 *    carries a digest of exactly the files to remove, and an apply has to pass it
 *    back. A file that changed between the preview and the apply no longer
 *    matches, so the run stops instead of deleting a file the operator never saw.
 * 2. **Only `delete` targets are touched.** `keep` and `refuse` are decisions the
 *    plan already made; the apply re-reads each file and re-checks size and
 *    digest, so a file that became current (or vanished) since the preview is
 *    not deleted.
 * 3. **The run reports what actually happened.** A failure removes nothing
 *    further and reports the files already deleted with their byte counts, so a
 *    partial run can be reconciled rather than guessed at.
 *
 * A repeated run is safe because it finds nothing old: the deleted database was
 * the only thing in scope, and records written afterwards are in the current
 * structure, which the plan keeps. "Safe to repeat" therefore comes from the
 * classification, not from a marker file.
 */
import {
  lstatSync,
  readdirSync,
  realpathSync,
  statSync,
  unlinkSync,
} from 'node:fs';
import { basename, dirname } from 'node:path';

import { sha256OfFile } from './inspect.ts';
import type { ResetPlan, ResetTarget } from './plan.ts';

/** One file this run removed, with the identity it had when it went. */
export interface RemovedFile {
  readonly name: string;
  readonly group: string;
  readonly bytes: number;
  readonly sha256: string | null;
  /** Tables and rows that went with it, so the tally can be reconciled. */
  readonly records: Readonly<Record<string, number>> | null;
}

/** One file the run declined to remove even though the plan named it. */
export interface SkippedFile {
  readonly name: string;
  readonly reason: string;
}

/** What an apply did. */
export interface ResetOutcome {
  readonly applied: boolean;
  /** Why the run stopped, when it did. */
  readonly reason: string | null;
  readonly removed: readonly RemovedFile[];
  readonly skipped: readonly SkippedFile[];
  readonly removedBytes: number;
  readonly removedRecords: number;
  /**
   * What is left in the plugin directory afterwards.
   *
   * Reported instead of asserting "the directory is empty": `last-good` lives
   * there and is deliberately kept, so the operator sees the real residue.
   */
  readonly remaining: readonly string[];
}

/** The rows one removed file accounted for, treating an unknown tally as zero. */
function rowsOf(file: RemovedFile): number {
  // An unreadable tally is already a refusal on the target, so a file that was
  // actually removed always has one; zero keeps the total finite regardless.
  if (file.records === null) return 0;
  return Object.values(file.records).reduce((a, b) => a + b, 0);
}

/** Totals for a partial run. */
function totals(removed: readonly RemovedFile[]): {
  readonly bytes: number;
  readonly records: number;
} {
  return {
    bytes: removed.reduce((sum, file) => sum + file.bytes, 0),
    records: removed.reduce((sum, file) => sum + rowsOf(file), 0),
  };
}

/** What one apply step left behind. */
interface Step {
  readonly removed: RemovedFile;
  /** Any refusal or failure stops the run. */
  readonly problem: string | null;
}

/** A file the plan named, as it looks right now. */
interface CurrentFile {
  readonly size: number;
  readonly sha256: string | null;
}

/** Read the current identity of a planned target, or `null` if it is gone. */
function currentFile(path: string): CurrentFile | null {
  try {
    return { size: statSync(path).size, sha256: sha256OfFile(path) };
  } catch {
    return null;
  }
}

/** Whether the file is still exactly what the plan described. */
function driftOf(target: ResetTarget): string | null {
  const current = currentFile(target.path);
  if (current === null) return 'the file is gone';
  if (current.size !== target.bytes)
    return `the file is now ${String(current.size)} bytes, not the ${String(
      target.bytes,
    )} the plan described`;
  // Size alone would let a same-size rewrite through, which is exactly what a
  // stale preview of a live database looks like.
  if (target.sha256 !== null && current.sha256 !== target.sha256)
    return 'the file content changed since the plan was made';
  return null;
}

/** Remove one planned target, refusing anything that has drifted. */
function removeOne(plan: ResetPlan, target: ResetTarget): Step {
  const removed: RemovedFile = {
    name: target.name,
    group: target.group,
    bytes: target.bytes,
    sha256: target.sha256,
    records: target.records,
  };
  const drift = targetDrift(plan, target) ?? driftOf(target);
  if (drift !== null) return { removed, problem: `${target.name}: ${drift}` };
  try {
    unlinkSync(target.path);
  } catch (error) {
    return {
      removed,
      problem: `${target.name} could not be removed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  return { removed, problem: null };
}

/**
 * Re-prove that the plan's directory is still the directory it was built from.
 *
 * A plan names absolute file paths, and a symbolic link swapped in for the
 * directory between the preview and the apply would make every path resolve
 * somewhere else while each file's own size and digest still matched — the
 * deletion would land outside the verified scope. Revalidating the canonical
 * real path immediately before the first unlink closes that window.
 */
function directoryDrift(plan: ResetPlan): string | null {
  let canonical: string;
  try {
    canonical = realpathSync(plan.directory);
  } catch (error) {
    return `the plugin directory ${plan.directory} can no longer be resolved: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (canonical !== plan.directory)
    return `the plugin directory ${plan.directory} now resolves to ${canonical}; the plan was made for the resolved path`;
  let stats;
  try {
    stats = lstatSync(plan.directory);
  } catch {
    return `the plugin directory ${plan.directory} no longer exists`;
  }
  if (stats.isSymbolicLink())
    return `the plugin directory ${plan.directory} became a symlink since the plan was made`;
  if (!stats.isDirectory())
    return `the plugin directory ${plan.directory} is no longer a directory`;
  return null;
}

/**
 * Re-prove that one target is still a direct child of the planned directory.
 *
 * The name and parent are checked together so a plan cannot be redirected at a
 * same-named file in another directory even if the plan object itself is stale.
 */
function targetDrift(plan: ResetPlan, target: ResetTarget): string | null {
  const parent = dirname(target.path);
  if (parent !== plan.directory)
    return `the target is not inside ${plan.directory} any more`;
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync(parent);
  } catch (error) {
    return `the containing directory could not be resolved: ${
      error instanceof Error ? error.message : String(error)
    }`;
  }
  if (canonicalParent !== plan.directory)
    return `the containing directory now resolves to ${canonicalParent}`;
  if (basename(target.path) !== target.name)
    return 'the target name does not match the plan';
  let stats;
  try {
    stats = lstatSync(target.path);
  } catch {
    return 'the file is gone';
  }
  // A symlink that replaced the file must be refused, not followed: unlinking it
  // would delete the link while the operator was told a file of data would go.
  if (stats.isSymbolicLink()) return 'the path is now a symlink';
  return null;
}

/** What is left in a directory, for the after-tally. */
function remainingIn(directory: string): readonly string[] {
  try {
    return readdirSync(directory).sort();
  } catch {
    return [];
  }
}

/**
 * The outcome of a run that removed nothing.
 *
 * `remaining` still lists the directory: a blocked run leaves every file where it
 * was, so reporting an empty directory would tell the operator their old data is
 * gone when it is not.
 */
function nothing(
  directory: string,
  reason: string,
  skipped: readonly SkippedFile[] = [],
): ResetOutcome {
  return {
    applied: false,
    reason,
    removed: [],
    skipped,
    removedBytes: 0,
    removedRecords: 0,
    remaining: remainingIn(directory),
  };
}

/** The checks that must pass before the first file is touched. */
function preflight(plan: ResetPlan, confirmation: string): ResetOutcome | null {
  if (plan.refusals.length > 0)
    return nothing(
      plan.directory,
      `the plan is blocked by ${String(plan.refusals.length)} refused target(s); resolve them before applying`,
    );
  if (plan.deleteCount === 0)
    return nothing(plan.directory, 'the plan has nothing to delete');
  if (confirmation !== plan.planId)
    return nothing(
      plan.directory,
      'the confirmation token does not match this plan; re-run the preview and pass its planId',
    );
  const drift = directoryDrift(plan);
  if (drift !== null)
    return nothing(
      plan.directory,
      `${drift}; re-run the preview against the current directory`,
    );
  return null;
}

/**
 * Apply a plan.
 *
 * The caller has already shown the plan and obtained the explicit reset flag;
 * this function's contract is that it deletes only what the plan names, only when
 * `confirmation` equals the plan's own digest, and only while every file still
 * matches what the operator was shown.
 */
export function applyPlan(plan: ResetPlan, confirmation: string): ResetOutcome {
  const blocked = preflight(plan, confirmation);
  if (blocked !== null) return blocked;

  const removed: RemovedFile[] = [];
  const skipped: SkippedFile[] = [];
  for (const target of plan.targets) {
    if (target.action !== 'delete') continue;
    const step = removeOne(plan, target);
    if (step.problem !== null) {
      skipped.push({ name: target.name, reason: step.problem });
      const partial = totals(removed);
      return {
        applied: false,
        reason: `${step.problem}; nothing further was removed`,
        removed,
        skipped,
        removedBytes: partial.bytes,
        removedRecords: partial.records,
        remaining: remainingIn(plan.directory),
      };
    }
    removed.push(step.removed);
  }
  const total = totals(removed);
  return {
    applied: true,
    reason: null,
    removed,
    skipped,
    removedBytes: total.bytes,
    removedRecords: total.records,
    remaining: remainingIn(plan.directory),
  };
}
