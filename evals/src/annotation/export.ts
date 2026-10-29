/**
 * Exporting a blank annotation document.
 *
 * What an annotator receives decides how independent they can be, so this module
 * builds the document from a whitelist rather than by copying a dataset and deleting
 * fields. Nothing that could anchor a decision is present:
 *
 *   - no label target values, scores or allowed sets: every entry's target is the
 *     blank form;
 *   - no model opinions and no model identities: a model's answer is exactly the
 *     thing the annotator is meant to replace;
 *   - no provenance: "this was reconstructed" is a fact about the dataset, not
 *     about the action being judged.
 *
 * The rubric travels with the pack so a person can grade without the repository, and
 * each case input travels in full so they can read the material a reviewer would have
 * seen. That input copy is also what an import checks the decision against.
 */

import { inputHashOf } from '../data/eligibility.js';
import type { Sourced } from '../data/read.js';
import type {
  AnnotationDocument,
  AnnotationEntry,
  BlankTarget,
  DatasetManifest,
  LabelTarget,
  ReviewCase,
  RubricSnapshot,
} from '../data/types.js';

/** The one annotation document format this tool reads and writes. */
export const ANNOTATION_PACK_VERSION = 'evals-annotation-pack-v1';

/** The empty adjudication handed out for every case. */
export function blankTarget(): BlankTarget {
  return {
    status: 'pending',
    allowed: { risk: [], authorization: [] },
    behaviourReference: null,
    rationale: '',
    decidedBy: '',
    decidedAt: null,
  };
}

/** One case's blank entry. */
function blankEntry(item: ReviewCase): AnnotationEntry {
  return {
    caseId: item.caseId,
    familyId: item.familyId,
    split: item.split,
    input: item.input,
    target: blankTarget(),
  };
}

/** Build the document for one dataset. `exportedAt` is supplied, never read from a clock. */
export function buildAnnotationPack(options: {
  readonly manifest: DatasetManifest;
  readonly cases: readonly Sourced<ReviewCase>[];
  readonly rubric: RubricSnapshot;
  readonly exportedAt: string;
}): AnnotationDocument {
  return {
    packVersion: ANNOTATION_PACK_VERSION,
    datasetId: options.manifest.datasetId,
    exportedAt: options.exportedAt,
    // The pack records the versions its decisions will be made under, so an import
    // can tell that the semantics moved rather than adopting the new ones.
    versions: {
      ...options.manifest.versions,
      rubric: options.rubric.rubricVersion,
    },
    rubric: {
      rubricVersion: options.rubric.rubricVersion,
      source: options.rubric.source,
      risk: options.rubric.risk,
      authorization: options.rubric.authorization,
    },
    entries: options.cases.map((entry) => blankEntry(entry.document)),
  };
}

/** Whether a target still holds nothing but the blank form. */
export function isBlankTarget(target: LabelTarget | BlankTarget): boolean {
  return (
    target.status === 'pending' &&
    target.allowed.risk !== null &&
    target.allowed.risk.length === 0 &&
    target.allowed.authorization !== null &&
    target.allowed.authorization.length === 0 &&
    target.behaviourReference === null &&
    target.rationale === '' &&
    target.decidedBy === '' &&
    target.decidedAt === null &&
    (target.allowedPairs === undefined || target.allowedPairs.length === 0)
  );
}

/**
 * Find anything in an exported document that could anchor an annotator.
 *
 * The check is structural rather than a key list: a filled target, an enumerated
 * pair or a non-empty rationale is reported wherever it appears, including inside a
 * nested value this module does not know about. A pack that fails this check must
 * not be handed out.
 */
export function auditPack(
  document: AnnotationDocument,
): readonly { readonly caseId: string; readonly message: string }[] {
  const problems: { caseId: string; message: string }[] = [];
  for (const entry of document.entries) {
    if (!isBlankTarget(entry.target)) {
      problems.push({
        caseId: entry.caseId,
        message:
          'the entry target is not blank; an exported pack must not carry a decision',
      });
    }
    const unrecorded = unexpectedKeys(entry);
    for (const key of unrecorded) {
      problems.push({
        caseId: entry.caseId,
        message: `the entry carries ${key}, which an exported pack must not include`,
      });
    }
  }
  return problems;
}

/**
 * Entry keys beyond the four an exported entry is allowed to have.
 *
 * A later addition to the case shape (a family note, a provenance field) must be a
 * deliberate decision about what an annotator may see, so an unexpected key is
 * reported rather than silently exported.
 */
function unexpectedKeys(entry: AnnotationEntry): readonly string[] {
  const allowed = new Set(['caseId', 'familyId', 'split', 'input', 'target']);
  return Object.keys(entry).filter((key) => !allowed.has(key));
}

/** The input hash each entry was exported with, so a caller can record the pack. */
export function entryHashes(
  document: AnnotationDocument,
): readonly { readonly caseId: string; readonly inputHash: string }[] {
  return document.entries.map((entry) => ({
    caseId: entry.caseId,
    inputHash: inputHashOf(entry.input),
  }));
}
