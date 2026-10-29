/**
 * Checking a filled annotation document before it becomes committed labels.
 *
 * This is the only path from a person's edit back into the dataset, so it is
 * deliberately suspicious. It refuses a fill rather than repairing one, and the
 * refusals are the point:
 *
 *   - the pack must be the one this dataset exported, so a fill cannot be spliced
 *     in from a different dataset or a different rubric version;
 *   - each entry's input is re-hashed and compared against the dataset's own case,
 *     so a fill made against material that has since changed is caught instead of
 *     being silently re-bound to the new input;
 *   - an entry still marked `pending` is not converted into anything: a half-filled
 *     pack imports the entries that were decided and reports the rest.
 *
 * Missing model versions are not a refusal. They are recorded as unknown in the
 * reviews file, which is where a reader looks for them.
 */

import {
  inputHashOf,
  isIndeterminate,
  legalPairs,
  mixesProhibition,
  unreachedBehaviour,
  versionsMatch,
} from '../data/eligibility.js';
import type { Sourced } from '../data/read.js';
import type {
  AnnotationDocument,
  AnnotationEntry,
  DatasetManifest,
  LabelVersions,
  ReviewCase,
  ReviewLabel,
  RubricSnapshot,
  ScorePair,
} from '../data/types.js';

/**
 * The enumerated pairs that sit outside one of the two allowed sets.
 *
 * `legalPairs` trusts an explicit `allowedPairs` list, which is right for reading a
 * decision but not for accepting one: a list is just numbers until it is compared
 * with the sets it claims to enumerate. Returning them lets the caller report which
 * pairs are wrong instead of only that something is.
 */
function pairsOutsideSets(label: ReviewLabel): readonly ScorePair[] {
  const pairs = legalPairs(label) ?? [];
  const risk = label.target.allowed.risk ?? [];
  const authorization = label.target.allowed.authorization ?? [];
  return pairs.filter(
    ([failure, permission]) =>
      !risk.includes(failure) || !authorization.includes(permission),
  );
}

/** One problem that stops an import. */
export interface ImportProblem {
  readonly caseId: string | null;
  readonly message: string;
}

/** A fill that passed every check, split into what it produced. */
export interface ImportResult {
  readonly problems: readonly ImportProblem[];
  /** Labels ready to be written, one per decided entry. */
  readonly labels: readonly ReviewLabel[];
  /** Entries whose target is still pending, by case id. */
  readonly pending: readonly string[];
}

/**
 * The versions a label records, taken from the pack rather than the manifest.
 *
 * The pack is what the annotator saw. Stamping the manifest's current versions onto
 * a decision made under older ones would claim a review that never happened, so the
 * export-time triple is used and any difference from the manifest is a refusal.
 */
function versionsOf(
  manifest: DatasetManifest,
  pack: AnnotationDocument,
): LabelVersions | null {
  return versionsMatch(pack.versions, manifest.versions) ? pack.versions : null;
}

/** Check that the fill belongs to this dataset and this rubric. */
function documentProblems(
  pack: AnnotationDocument,
  manifest: DatasetManifest,
  rubric: RubricSnapshot,
): readonly ImportProblem[] {
  const problems: ImportProblem[] = [];
  if (pack.datasetId !== manifest.datasetId) {
    problems.push({
      caseId: null,
      message: `the fill names dataset ${pack.datasetId}, this dataset is ${manifest.datasetId}`,
    });
  }
  if (pack.rubric.rubricVersion !== rubric.rubricVersion) {
    problems.push({
      caseId: null,
      message: `the fill was made against rubric ${pack.rubric.rubricVersion}, the committed snapshot is ${rubric.rubricVersion}`,
    });
  }
  if (pack.rubric.source.sha256 !== rubric.source.sha256) {
    problems.push({
      caseId: null,
      message: `the fill quotes rubric document ${pack.rubric.source.sha256}, the committed snapshot records ${rubric.source.sha256}`,
    });
  }
  for (const [name, recorded, current] of [
    ['contract', pack.versions.contract, manifest.versions.contract],
    ['rubric', pack.versions.rubric, manifest.versions.rubric],
    ['policy', pack.versions.policy, manifest.versions.policy],
  ] as const) {
    if (recorded !== current) {
      problems.push({
        caseId: null,
        message: `the fill was exported under ${name} ${recorded}, this dataset now declares ${current}; re-export the pack and decide the case again`,
      });
    }
  }
  return problems;
}

/**
 * One entry's problems, and the case it may become a label for.
 *
 * An entry whose input no longer matches is not turned into a label at all: the
 * adjudication was about different material, and keeping it under the case id would
 * claim a decision nobody made.
 */
function entryProblems(
  entry: AnnotationEntry,
  cases: ReadonlyMap<string, ReviewCase>,
): {
  readonly problems: readonly ImportProblem[];
  readonly target: ReviewCase | null;
} {
  const target = cases.get(entry.caseId);
  if (target === undefined) {
    return {
      problems: [
        {
          caseId: entry.caseId,
          message: `the fill names case ${entry.caseId}, which this dataset does not hold`,
        },
      ],
      target: null,
    };
  }
  if (inputHashOf(entry.input) !== inputHashOf(target.input)) {
    const recorded = inputHashOf(entry.input);
    return {
      problems: [
        {
          caseId: entry.caseId,
          message: `the fill was made against input ${recorded}, the case now hashes to ${inputHashOf(target.input)}; re-export the pack and decide this case again`,
        },
      ],
      target: null,
    };
  }
  if (entry.target.status === 'pending') {
    return { problems: [], target: null };
  }
  return { problems: [], target };
}

/**
 * Import one filled document.
 *
 * A decided entry has to name its author. An unattributed adjudication cannot be
 * traced back to the person who made it, so it is refused rather than filed under
 * whoever happened to run the import.
 */
export function importFill(options: {
  readonly pack: AnnotationDocument;
  readonly manifest: DatasetManifest;
  readonly rubric: RubricSnapshot;
  readonly cases: readonly Sourced<ReviewCase>[];
}): ImportResult {
  const { pack, manifest, rubric, cases } = options;
  const documentProblemList = documentProblems(pack, manifest, rubric);
  // A fill that is not for this dataset and this rubric cannot contribute any label
  // at all: its decisions were made against different material, so accepting the
  // entries that happen to parse would file them as if they were about this data.
  if (documentProblemList.length > 0) {
    return { problems: documentProblemList, labels: [], pending: [] };
  }
  const problems: ImportProblem[] = [];
  const versions = versionsOf(manifest, pack);
  const caseById = new Map(
    cases.map((entry) => [entry.document.caseId, entry.document] as const),
  );
  const labels: ReviewLabel[] = [];
  const pending: string[] = [];

  for (const entry of pack.entries) {
    const result = entryProblems(entry, caseById);
    problems.push(...result.problems);
    if (result.problems.length > 0) continue;
    if (result.target === null) {
      pending.push(entry.caseId);
      continue;
    }
    const decidedBy = entry.target.decidedBy.trim();
    if (decidedBy === '') {
      problems.push({
        caseId: entry.caseId,
        message: 'a decided entry must name who decided it in decidedBy',
      });
      continue;
    }
    const label: ReviewLabel = {
      caseId: entry.caseId,
      inputHash: inputHashOf(entry.input),
      // A null versions value only happens when the document problems already
      // refused the fill, so this branch is unreachable in a reported import.
      versions: versions ?? manifest.versions,
      target: { ...entry.target, decidedBy },
    };
    if (mixesProhibition(label.target.allowed)) {
      problems.push({
        caseId: entry.caseId,
        message:
          'authorization combines band 1 (an applicable prohibition) with other bands; decide one or the other',
      });
      continue;
    }
    if (isIndeterminate(label)) {
      problems.push({
        caseId: entry.caseId,
        message:
          'an approved label must name at least one legal pair and a behaviour reference',
      });
      continue;
    }
    if (unreachedBehaviour(label)) {
      problems.push({
        caseId: entry.caseId,
        message: `the recorded behaviour ${String(entry.target.behaviourReference)} is not the stage the legal pairs reach`,
      });
      continue;
    }
    const outside = pairsOutsideSets(label);
    if (outside.length > 0) {
      // The dataset check rejects these through pairProblems, so accepting them here
      // would write a label the very next `check` refuses.
      problems.push({
        caseId: entry.caseId,
        message: `allowed pair ${outside
          .map(
            ([risk, authorization]) =>
              `${String(risk)}/${String(authorization)}`,
          )
          .join(', ')} falls outside the allowed sets`,
      });
      continue;
    }
    labels.push(label);
  }
  return { problems, labels, pending };
}
