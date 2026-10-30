/**
 * Whether the material a run replayed is still the material the dataset holds.
 *
 * A replay re-reads saved answers, so a changed input cannot change a derived score —
 * the question was already sent. What it *does* change is what the derivation is
 * evidence about: an answer produced from the old input says nothing about the new one,
 * and no amount of re-reading can make it. The frozen issue states that an input change
 * requires a new request, so this module answers one question — did any case the run
 * submitted change since — and leaves the warning to its callers.
 *
 * Nothing here compares labels. A label mismatch is the report layer's diagnostic and
 * covers a different failure (a human decision made against material that has since
 * moved); a dataset with no labels at all still has inputs, and an input change still
 * invalidates a replay of it.
 */

import { join } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';

import { inputHashOf } from '../data/eligibility.js';
import { readDataset } from '../data/read.js';
import type { Sourced } from '../data/read.js';
import { compileCheckers } from '../data/schemas.js';
import { inspectDataset } from '../data/inspect.js';
import type { DatasetInspection } from '../data/inspect.js';
import type { CellRecord } from '../run/types.js';

/**
 * The case id a `cases/<id>.json` problem path names, if it names one.
 *
 * The inspector reports a dropped case by the path it read, so the id has to come back
 * out of that path for the case to be reported as unverified rather than silently
 * missing. A problem with any other path belongs to the dataset as a whole and is left
 * to the dataset check.
 */
function caseIdOfPath(path: string): string | null {
  const match = /^cases\/(.+)\.json$/u.exec(path);
  return match?.[1] ?? null;
}

/**
 * The rubric version a manifest declares.
 *
 * Read structurally rather than through the manifest checker, because the comparison
 * needs a dataset's inputs, not its publication status: a dataset whose rubric version
 * moved is still readable, and refusing to say whether its inputs changed would hide
 * the answer behind an unrelated defect.
 */
function memberOf(value: unknown, name: string): unknown {
  if (value === null || typeof value !== 'object') return undefined;
  return Reflect.get(value, name);
}

function rubricVersionOf(manifest: Sourced | null): string {
  const declared = memberOf(memberOf(manifest, 'document'), 'versions');
  const rubric = memberOf(declared, 'rubric');
  return typeof rubric === 'string' ? rubric : '';
}

/** One case whose current input no longer matches what the run submitted. */
export interface InputDrift {
  readonly caseId: string;
  /** The fingerprint stored in the run's records. */
  readonly recorded: string;
  /** The fingerprint of the case as the dataset holds it now. */
  readonly current: string;
}

/**
 * A case the comparison could not settle, with the reason it could not.
 *
 * Kept separate from {@link InputDrift} because the two answer different questions:
 * drift says "the material moved", and this says "nobody knows whether it moved". A
 * caller that merged them would report a changed input that may not have changed, or
 * worse, drop the case and imply it was verified.
 */
export interface UnverifiedInput {
  readonly caseId: string;
  readonly reason: string;
}

/** What comparing a run against its dataset produced. */
export type InputComparison =
  | {
      readonly status: 'compared';
      readonly drifted: readonly InputDrift[];
      /** Recorded cases whose current input could not be established. */
      readonly unverified: readonly UnverifiedInput[];
    }
  /** The dataset could not be read, so the question was not answered either way. */
  | { readonly status: 'unavailable'; readonly reason: string };

/**
 * The input fingerprint each case of a run was recorded with.
 *
 * Every record for a case carries the same value — the material is read once per case
 * and every cell of it submits the same input — so a disagreement is reported rather
 * than resolved by taking the first: it would mean two cells of one case sent different
 * material, which the run artifact contract forbids.
 */
function recordedInputs(records: readonly CellRecord[]): {
  readonly byCase: ReadonlyMap<string, string>;
  readonly conflicts: readonly string[];
} {
  const byCase = new Map<string, string>();
  const conflicts: string[] = [];
  for (const record of records) {
    const previous = byCase.get(record.case.caseId);
    if (previous !== undefined && previous !== record.case.inputHash) {
      conflicts.push(record.case.caseId);
      continue;
    }
    byCase.set(record.case.caseId, record.case.inputHash);
  }
  return { byCase, conflicts };
}

/**
 * Compare a run's recorded inputs against the dataset as it is now.
 *
 * A case the dataset no longer holds is not reported as drift: it was removed, which is
 * a different event and one the report layer already surfaces as a missing case. Only a
 * case that is present with a *different* input means the saved answer no longer speaks
 * about the current material.
 */
export async function compareInputs(parts: {
  readonly root: string;
  readonly dataset: string;
  readonly records: readonly CellRecord[];
}): Promise<InputComparison> {
  const { byCase, conflicts } = recordedInputs(parts.records);
  if (conflicts.length > 0) {
    return {
      status: 'unavailable',
      reason: `records disagree about the input hash of ${conflicts.join(', ')}; the run artifact contract requires one input per case`,
    };
  }
  const absolute = parts.dataset.startsWith('/')
    ? parts.dataset
    : join(parts.root, parts.dataset);
  let inspection: DatasetInspection;
  try {
    const checkers = await compileCheckers();
    const raw = await readDataset(absolute);
    inspection = inspectDataset(raw, checkers, {
      // Only the declared rubric version matters here, and only because the inspector
      // asks. An empty string is what the report layer itself passes for a manifest that
      // declares none, so the same reading applies in both places.
      contract: REVIEW_CONTRACT_VERSION,
      rubric: rubricVersionOf(raw.manifest),
    });
  } catch (error) {
    return {
      status: 'unavailable',
      reason: `${parts.dataset} could not be read: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  // `readDataset` reports an unreadable dataset through problems rather than by throwing,
  // and `inspectDataset` drops a case whose document does not match its schema while
  // keeping the rest. Both make an empty or partial case list indistinguishable from a
  // complete one, so coverage is established from what came back, never assumed.
  if (inspection.cases.length === 0) {
    return {
      status: 'unavailable',
      reason: `${parts.dataset} yielded no readable case, so the run's inputs could not be compared`,
    };
  }
  const present = new Map(
    inspection.cases.map((entry) => [entry.document.caseId, entry] as const),
  );
  const unverified: UnverifiedInput[] = [];
  // A case file that failed to parse is listed as unverified rather than counted as
  // unchanged: the run recorded an input for it, and nothing read that input back.
  for (const problem of inspection.problems) {
    const caseId = caseIdOfPath(problem.path);
    if (caseId === null || !byCase.has(caseId)) continue;
    if (present.has(caseId)) continue;
    unverified.push({
      caseId,
      reason: `${problem.path} could not be read (${problem.message}), so its input was not compared`,
    });
  }
  for (const caseId of byCase.keys()) {
    if (present.has(caseId)) continue;
    if (unverified.some((entry) => entry.caseId === caseId)) continue;
    unverified.push({
      caseId,
      reason: `${parts.dataset} holds no usable ${caseId}, so its input was not compared`,
    });
  }
  const drifted: InputDrift[] = [];
  for (const [caseId, recorded] of byCase) {
    const entry = present.get(caseId);
    if (entry === undefined) continue;
    const current = inputHashOf(entry.document.input);
    if (current !== recorded) drifted.push({ caseId, recorded, current });
  }
  // A dataset holding none of the run's cases is not a clean comparison, even though it
  // yields no drift: it means the question was never put to anything.
  if (drifted.length === 0 && unverified.length === byCase.size) {
    return {
      status: 'unavailable',
      reason: `${parts.dataset} holds none of the run's ${String(byCase.size)} case(s), so the run's inputs could not be compared`,
    };
  }
  return { status: 'compared', drifted, unverified };
}
