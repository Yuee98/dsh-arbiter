/**
 * Dataset-level checks: the rules one document cannot state alone.
 *
 * A JSON Schema can say what a label looks like; it cannot say that the case it
 * names exists, that the case's family owns the split it claims, that every case in
 * the manifest was found, or that a label's recorded input hash still matches the
 * input. Those are the checks that make "this label is stale" a fact rather than a
 * hope, so they live here and each one names the file it points at.
 *
 * The result separates problems from findings. A problem must stop a run; a finding
 * is something a person should look at — an input changed, or a model opinion
 * disagreeing with the human reference — and never blocks on its own.
 */

import { assessLabels } from './eligibility.js';
import type { GoldStatus, LabelAssessment } from './eligibility.js';
import {
  hasUnscoredField,
  inputHashOf,
  isIndeterminate,
  legalPairs,
  matrixBehaviours,
  mixesProhibition,
} from './eligibility.js';
import { documentName } from './read.js';
import type { RawDataset, Sourced } from './read.js';
import type { Checker, Checkers } from './schemas.js';
import type {
  CaseReviews,
  DatasetManifest,
  ReviewCase,
  ReviewLabel,
  ScorePair,
} from './types.js';

/** One message, with the dataset-relative file it points at. */
export interface Finding {
  readonly path: string;
  readonly message: string;
}

/**
 * Which part of a dataset a finding is about.
 *
 * The distinction matters because the commands need different subsets. Exporting a
 * blank pack only needs valid cases, a manifest and a rubric; a stale label is
 * exactly the thing a re-export is supposed to fix, so refusing to export over one
 * would leave the documented recovery unreachable. `check` still refuses, because a
 * dataset claiming an adjudication nobody made must not pass.
 */
export type FindingOrigin = 'manifest' | 'case' | 'label' | 'reviews';

/** The part of a dataset one finding is about, by the file it names. */
export function findingOrigin(finding: Finding): FindingOrigin {
  if (finding.path.startsWith('labels/') || finding.path.startsWith('label'))
    return 'label';
  if (finding.path.startsWith('reviews/')) return 'reviews';
  if (finding.path.startsWith('cases/')) return 'case';
  return 'manifest';
}

/**
 * The versions in force, as the running code and the committed snapshot name them.
 *
 * A dataset's manifest declares the versions its labels were made under, and nothing
 * else in this module compares that declaration with what the code actually
 * implements. Without this input two obsolete values would agree with each other
 * while disagreeing with the repository, and every label in the dataset would be
 * reported as gold under scoring semantics nothing here implements.
 */
export interface CurrentVersions {
  readonly contract: string;
  readonly rubric: string;
}

/** Everything a dataset check produced. */
export interface DatasetInspection {
  /** Defects that make the dataset unusable as published data. */
  readonly problems: readonly Finding[];
  /** Things a person should look at; none of them blocks a run on its own. */
  readonly findings: readonly Finding[];
  /** The manifest, when it parsed and matched its schema. */
  readonly manifest: DatasetManifest | null;
  /** Labels that count as gold, and labels that do not, with their reasons. */
  readonly labels: GoldStatus;
  /** The cases that parsed, keyed by id, for a caller that needs their inputs. */
  readonly cases: readonly Sourced<ReviewCase>[];
  /** The opinion files that parsed, for a caller that needs to compare models. */
  readonly reviews: readonly Sourced<CaseReviews>[];
}

/**
 * Keep only the documents that matched their schema.
 *
 * Each rejection contributes its own message to `problems` and the file is dropped,
 * so a later check never works from a half-valid document.
 */
function keep<T>(
  entries: readonly Sourced[],
  check: Checker<T>,
  problems: Finding[],
): readonly Sourced<T>[] {
  const kept: Sourced<T>[] = [];
  for (const entry of entries) {
    const checked = check(entry.document);
    if (checked.ok) kept.push({ path: entry.path, document: checked.document });
    else
      for (const message of checked.problems) {
        problems.push({ path: entry.path, message });
      }
  }
  return kept;
}

/** Check that no two documents in one directory claim the same id. */
function duplicateIds<T>(
  entries: readonly { readonly path: string; readonly document: T }[],
  idOf: (document: T) => string,
  kind: string,
): readonly Finding[] {
  const seen = new Map<string, string>();
  const problems: Finding[] = [];
  for (const entry of entries) {
    const id = idOf(entry.document);
    const previous = seen.get(id);
    if (previous !== undefined) {
      problems.push({
        path: entry.path,
        message: `${kind} ${id} is also declared by ${previous}`,
      });
      continue;
    }
    seen.set(id, entry.path);
  }
  return problems;
}

/**
 * A document's file has to be named after the id it declares.
 *
 * Without this a case can be moved by renaming a file while its id stays behind, and
 * every later report about "case X" points at a path that no longer holds it.
 */
function fileMatchesId<T>(
  entries: readonly { readonly path: string; readonly document: T }[],
  idOf: (document: T) => string,
  kind: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  for (const entry of entries) {
    const expected = documentName(entry.path);
    const actual = idOf(entry.document);
    if (expected !== actual) {
      problems.push({
        path: entry.path,
        message: `${kind} file ${expected} declares id ${actual}; a document's file name is its id`,
      });
    }
  }
  return problems;
}

/** Check the manifest describes the cases that exist, and no others. */
function manifestCoverage(
  manifest: DatasetManifest,
  cases: readonly Sourced<ReviewCase>[],
): readonly Finding[] {
  const problems: Finding[] = [];
  const families = new Map(
    manifest.families.map((family) => [family.familyId, family] as const),
  );
  const caseById = new Map(
    cases.map((entry) => [entry.document.caseId, entry] as const),
  );
  const declared = new Set(manifest.cases.map((entry) => entry.caseId));

  for (const caseId of declared) {
    if (!caseById.has(caseId)) {
      problems.push({
        path: 'manifest.json',
        message: `manifest declares case ${caseId}, which has no file in cases/`,
      });
    }
  }
  for (const entry of cases) {
    const { caseId, familyId, split } = entry.document;
    if (!declared.has(caseId)) {
      problems.push({
        path: entry.path,
        message: `case ${caseId} is not declared in manifest.json`,
      });
    }
    const family = families.get(familyId);
    if (family === undefined) {
      problems.push({
        path: entry.path,
        message: `case ${caseId} names family ${familyId}, which the manifest does not declare`,
      });
    } else if (family.split !== split) {
      problems.push({
        path: entry.path,
        message: `case ${caseId} claims split ${split} but family ${familyId} is assigned ${family.split}`,
      });
    }
  }
  for (const family of manifest.families) {
    if (!cases.some((entry) => entry.document.familyId === family.familyId)) {
      problems.push({
        path: 'manifest.json',
        message: `family ${family.familyId} declares no case`,
      });
    }
  }
  return problems;
}

/** Check a label's own coherence, independently of whether it counts as gold. */
function labelCoherence(label: ReviewLabel, path: string): readonly Finding[] {
  const problems: Finding[] = [];
  const { target } = label;
  if (target.status !== 'approved') return problems;
  if (mixesProhibition(target.allowed)) {
    problems.push({
      path,
      message:
        'authorization combines band 1 (an applicable prohibition) with other bands; a prohibition denies at every risk, so these are opposite decisions rather than an interval',
    });
  }
  if (target.behaviourReference === null) {
    problems.push({
      path,
      message: 'an approved label must record a behaviour reference',
    });
  }
  const pairs = legalPairs(label);
  if (pairs === null) {
    // A null field records that the material could not support a score, which is a
    // complete adjudication; only a label that claims a decision while naming no
    // pair is a drafting mistake.
    if (hasUnscoredField(label)) return problems;
    problems.push({
      path,
      message:
        'an approved label must name at least one legal pair: enumerate allowedPairs whenever either allowed set holds more than one value',
    });
    return problems;
  }
  problems.push(...pairProblems(label, pairs, path));
  return problems;
}

/** Every pair has to sit inside both sets, and the recorded stage has to be reachable. */
function pairProblems(
  label: ReviewLabel,
  pairs: readonly ScorePair[],
  path: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  const risk = label.target.allowed.risk ?? [];
  const authorization = label.target.allowed.authorization ?? [];
  for (const pair of pairs) {
    if (!risk.includes(pair[0]) || !authorization.includes(pair[1])) {
      problems.push({
        path,
        message: `allowed pair ${String(pair[0])}/${String(pair[1])} is outside the allowed sets`,
      });
    }
  }
  const reference = label.target.behaviourReference;
  if (reference === null || isIndeterminate(label)) return problems;
  const behaviours = matrixBehaviours(pairs).map((entry) => entry.behaviour);
  if (!behaviours.includes(reference)) {
    problems.push({
      path,
      message: `behaviour reference ${reference} is not reachable from the legal pairs (${[...new Set(behaviours)].join(', ')})`,
    });
  }
  return problems;
}

/** Check every review file against the case and label it names. */
function reviewCoherence(
  reviews: readonly Sourced<CaseReviews>[],
  cases: readonly Sourced<ReviewCase>[],
  labels: readonly Sourced<ReviewLabel>[],
): readonly Finding[] {
  const problems: Finding[] = [];
  const caseById = new Map(
    cases.map((entry) => [entry.document.caseId, entry.document] as const),
  );
  const labelByCase = new Map(
    labels.map((entry) => [entry.document.caseId, entry.document] as const),
  );
  for (const entry of reviews) {
    const { caseId, inputHash, reviews: opinions } = entry.document;
    const target = caseById.get(caseId);
    if (target === undefined) {
      problems.push({
        path: entry.path,
        message: `reviews name case ${caseId}, which has no file in cases/`,
      });
      continue;
    }
    const actual = inputHashOf(target.input);
    if (actual !== inputHash) {
      problems.push({
        path: entry.path,
        message: `reviews were recorded against input ${inputHash}, the case now hashes to ${actual}`,
      });
    }
    const label = labelByCase.get(caseId);
    if (label !== undefined && label.inputHash !== inputHash) {
      problems.push({
        path: entry.path,
        message: `reviews and the label for ${caseId} were recorded against different inputs`,
      });
    }
    problems.push(...opinionProblems(opinions, entry.path));
  }
  return problems;
}

/** One case's opinions: unique ids, and a version that matches its stated source. */
function opinionProblems(
  opinions: CaseReviews['reviews'],
  path: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  const seen = new Set<string>();
  for (const opinion of opinions) {
    if (seen.has(opinion.reviewId)) {
      problems.push({
        path,
        message: `review ${opinion.reviewId} appears twice in one file`,
      });
    }
    seen.add(opinion.reviewId);
    const { version, versionSource } = opinion.model;
    if (version === null && versionSource !== 'unknown') {
      problems.push({
        path,
        message: `review ${opinion.reviewId} has no model version but claims source ${versionSource}`,
      });
    }
    if (version !== null && versionSource === 'unknown') {
      problems.push({
        path,
        message: `review ${opinion.reviewId} records a version but marks its source unknown`,
      });
    }
  }
  return problems;
}

/**
 * Compare the manifest's declared versions with the ones the repository implements.
 *
 * Labels are checked against the manifest, which makes the manifest the anchor for
 * every decision in the dataset. If the manifest itself names a contract or a rubric
 * that is no longer current, the agreement between manifest and labels proves
 * nothing: both would describe semantics that are not the ones in this checkout. The
 * policy version is deliberately not compared here, because the reviewer policy
 * belongs to the production task that owns it rather than to this contract.
 */
function manifestVersions(
  manifest: DatasetManifest,
  current: CurrentVersions,
): readonly Finding[] {
  const problems: Finding[] = [];
  if (manifest.versions.contract !== current.contract) {
    problems.push({
      path: 'manifest.json',
      message: `manifest declares contract ${manifest.versions.contract}, the running contract is ${current.contract}; every label in this dataset needs review`,
    });
  }
  if (manifest.versions.rubric !== current.rubric) {
    problems.push({
      path: 'manifest.json',
      message: `manifest declares rubric ${manifest.versions.rubric}, the committed snapshot is ${current.rubric}; every label in this dataset needs review`,
    });
  }
  return problems;
}

/**
 * Turn a binding that no longer holds into a problem.
 *
 * A label whose case is gone, whose input moved, or which was made under a version
 * that is no longer in force is not a lower-quality label: it is a decision about
 * material that is not the material in the repository, and keeping it would let a
 * metric claim a decision nobody made. A `pending` label is different — that is the
 * ordinary state of a case before the annotation window reaches it — so it is
 * reported as a note rather than a problem.
 */
function staleLabels(status: GoldStatus): readonly Finding[] {
  const problems: Finding[] = [];
  for (const assessment of status.excluded) {
    // `no-score` says the material could not be judged, which is a legitimate
    // adjudication rather than a broken binding, so it is reported as a note.
    const stale = assessment.reasons.filter(
      (reason) => reason !== 'not-approved' && reason !== 'no-score',
    );
    if (stale.length === 0) continue;
    problems.push({
      path: assessment.path,
      message: `this label cannot count (${stale.join(', ')}); decide the case again against the input now in the repository`,
    });
  }
  return problems;
}

/**
 * Report where a model opinion reaches a different behaviour than the human
 * reference.
 *
 * These are findings, never corrections: the label is the answer and the engine is
 * what is being measured, so a disagreement is the signal the dataset exists to
 * produce. Nothing here writes back to a label.
 */
function disagreements(
  gold: readonly LabelAssessment[],
  reviews: readonly Sourced<CaseReviews>[],
): readonly Finding[] {
  const findings: Finding[] = [];
  const reviewByCase = new Map(
    reviews.map((entry) => [entry.document.caseId, entry] as const),
  );
  for (const assessment of gold) {
    const label = assessment.label;
    const reference = label.target.behaviourReference;
    if (reference === null) continue;
    const entry = reviewByCase.get(label.caseId);
    if (entry === undefined) {
      findings.push({
        path: assessment.path,
        message: `no model opinion is recorded for approved case ${label.caseId}`,
      });
      continue;
    }
    for (const opinion of entry.document.reviews) {
      const risk = opinion.risk;
      const authorization = opinion.authorization;
      if (risk === null || authorization === null) continue;
      const observed = matrixBehaviours([[risk, authorization]])[0]?.behaviour;
      if (observed !== undefined && observed !== reference) {
        findings.push({
          path: assessment.path,
          message: `review ${opinion.reviewId} reaches ${observed} at ${String(risk)}/${String(authorization)}; the reference for ${label.caseId} is ${reference}`,
        });
      }
    }
  }
  return findings;
}

/**
 * Check one dataset directory.
 *
 * Every list in the result is built in file order, so two runs over the same
 * dataset produce the same messages in the same order.
 */
export function inspectDataset(
  raw: RawDataset,
  checkers: Checkers,
  current: CurrentVersions,
): DatasetInspection {
  const problems: Finding[] = raw.problems.map((problem) => ({
    path: problem.path,
    message: problem.message,
  }));

  let manifest: DatasetManifest | null = null;
  if (raw.manifest !== null) {
    const checked = checkers.manifest(raw.manifest.document);
    if (checked.ok) manifest = checked.document;
    else
      for (const message of checked.problems) {
        problems.push({ path: raw.manifest.path, message });
      }
  }

  const cases = keep(raw.cases, checkers.case, problems);
  const labels = keep(raw.labels, checkers.label, problems);
  const reviews = keep(raw.reviews, checkers.reviews, problems);

  problems.push(
    ...duplicateIds(cases, (item) => item.caseId, 'case'),
    ...fileMatchesId(cases, (item) => item.caseId, 'case'),
    ...duplicateIds(labels, (item) => item.caseId, 'label'),
    ...fileMatchesId(labels, (item) => item.caseId, 'label'),
    ...duplicateIds(reviews, (item) => item.caseId, 'reviews'),
    ...fileMatchesId(reviews, (item) => item.caseId, 'reviews'),
  );
  if (manifest === null) {
    problems.push({
      path: 'manifest.json',
      message: 'a dataset needs a manifest.json matching manifest.schema.json',
    });
  } else {
    problems.push(...manifestCoverage(manifest, cases));
  }
  for (const entry of labels) {
    problems.push(...labelCoherence(entry.document, entry.path));
  }
  problems.push(...reviewCoherence(reviews, cases, labels));

  if (manifest !== null) {
    problems.push(...manifestVersions(manifest, current));
  }

  const labelStatus = assessLabels(cases, labels, manifest);
  problems.push(...staleLabels(labelStatus));
  const findings = disagreements(labelStatus.gold, reviews);
  return { problems, findings, manifest, labels: labelStatus, cases, reviews };
}
