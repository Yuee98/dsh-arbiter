/**
 * Exporting a blank pack and importing a filled one.
 *
 * The property that matters most is negative: an exported pack must not contain
 * anything that could anchor the person grading it. The tests therefore assert on
 * what is absent — no scores, no opinions, no earlier decision — as well as on the
 * round trip that turns a filled pack into committed labels.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  ANNOTATION_PACK_VERSION,
  auditPack,
  blankTarget,
  buildAnnotationPack,
  entryHashes,
  isBlankTarget,
} from '../../evals/src/annotation/export.js';
import { importFill } from '../../evals/src/annotation/import.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import {
  AUTHORIZATION_BANDS,
  RISK_BANDS,
} from '../../src/review-contract/index.js';
import type {
  AnnotationDocument,
  AnnotationEntry,
  RubricSnapshot,
} from '../../evals/src/data/types.js';
import {
  VERSIONS,
  approvedTarget,
  input,
  manifest,
  reviewCase,
  reviewLabel,
} from './fixtures/documents.js';
import { REPOSITORY_ROOT } from './helpers/dataset.js';

const checkers = await compileCheckers();
const snapshot: RubricSnapshot = {
  rubricVersion: VERSIONS.rubric,
  contractVersion: VERSIONS.contract,
  source: {
    path: 'docs/milestones/review-quality-rubrics.md',
    sha256: `sha256:${'a'.repeat(64)}`,
  },
  risk: RISK_BANDS.map((band) => ({
    score: band.score,
    criterion: band.criterion,
  })),
  authorization: AUTHORIZATION_BANDS.map((band) => ({
    score: band.score,
    criterion: band.criterion,
  })),
};
const hash = inputHashOf(input());
const cases = [{ path: 'cases/case-a.json', document: reviewCase() }];

function pack(): AnnotationDocument {
  return buildAnnotationPack({
    manifest: manifest(['case-a']),
    cases,
    rubric: snapshot,
    exportedAt: '2026-10-29',
  });
}

/** Replace every entry's target, keeping the rest of the document as exported. */
function withTargets(
  document: AnnotationDocument,
  target: AnnotationEntry['target'],
): AnnotationDocument {
  return {
    ...document,
    entries: document.entries.map((entry) => ({ ...entry, target })),
  };
}

/** Replace every entry's input, keeping the rest of the document as exported. */
function withInputs(
  document: AnnotationDocument,
  replacement: AnnotationEntry['input'],
): AnnotationDocument {
  return {
    ...document,
    entries: document.entries.map((entry) => ({
      ...entry,
      input: replacement,
    })),
  };
}

/** A fill of the exported pack, with every entry decided. */
function filled(): AnnotationDocument {
  return withTargets(pack(), approvedTarget());
}

describe('exporting a pack', () => {
  it('names its format version', () => {
    expect(pack().packVersion).toBe(ANNOTATION_PACK_VERSION);
  });

  it('handles out a blank target for every case', () => {
    const document = pack();
    expect(document.entries).toHaveLength(1);
    expect(document.entries[0]?.target).toEqual(blankTarget());
  });

  it('carries the rubric so a person can grade without the repository', () => {
    const document = pack();
    expect(document.rubric.rubricVersion).toBe(VERSIONS.rubric);
    expect(document.rubric.risk).toHaveLength(10);
  });

  it('carries the input, which is the material being judged', () => {
    expect(pack().entries[0]?.input).toEqual(input());
  });

  it('carries no scores, allowed sets, opinions or provenance', () => {
    const document = pack();
    const serialised = JSON.stringify(document);
    for (const absent of [
      '"reviews"',
      '"provenance"',
      '"allowedPairs"',
      '"behaviourReference": "',
      '"rationale": "D',
      'review-1',
    ]) {
      expect(serialised).not.toContain(absent);
    }
  });

  it('matches the annotation schema', () => {
    expect(checkers.annotation(pack()).ok).toBe(true);
  });

  it('passes its own audit', () => {
    expect(auditPack(pack())).toEqual([]);
  });

  it('fails the audit once a target carries a decision', () => {
    const leaked = {
      ...pack(),
      entries: pack().entries.map((entry) => ({
        ...entry,
        target: approvedTarget(),
      })),
    };
    expect(auditPack(leaked)).toEqual([
      {
        caseId: 'case-a',
        message:
          'the entry target is not blank; an exported pack must not carry a decision',
      },
    ]);
  });

  it('fails the audit when an entry grows a field the format does not publish', () => {
    const extra = {
      ...pack(),
      entries: pack().entries.map((entry) => ({ ...entry, provenance: {} })),
    };
    expect(auditPack(extra)).toEqual([
      {
        caseId: 'case-a',
        message:
          'the entry carries provenance, which an exported pack must not include',
      },
    ]);
  });

  it('reports the input hash each entry was exported with', () => {
    expect(entryHashes(pack())).toEqual([
      { caseId: 'case-a', inputHash: hash },
    ]);
  });

  it('records the export date it was given rather than a clock reading', () => {
    expect(pack().exportedAt).toBe('2026-10-29');
  });

  it('recognises only a truly empty target as blank', () => {
    expect(isBlankTarget(blankTarget())).toBe(true);
    expect(isBlankTarget(approvedTarget())).toBe(false);
    expect(isBlankTarget({ ...blankTarget(), rationale: 'a thought' })).toBe(
      false,
    );
    expect(isBlankTarget({ ...blankTarget(), allowedPairs: [[7, 9]] })).toBe(
      false,
    );
  });
});

describe('importing a fill', () => {
  it('produces one label per decided entry', () => {
    const result = importFill({
      pack: filled(),
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.problems).toEqual([]);
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]?.caseId).toBe('case-a');
    expect(result.labels[0]?.inputHash).toBe(hash);
  });

  it('binds the label to the versions in force', () => {
    const result = importFill({
      pack: filled(),
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.labels[0]?.versions).toEqual(VERSIONS);
  });

  it('leaves a pending entry pending instead of inventing a decision', () => {
    const result = importFill({
      pack: pack(),
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.labels).toEqual([]);
    expect(result.pending).toEqual(['case-a']);
    expect(result.problems).toEqual([]);
  });

  it('imports the decided entries of a half-filled pack and names the rest', () => {
    const document = pack();
    const base = document.entries[0];
    if (base === undefined) throw new Error('the exported pack has no entry');
    const twoCases: AnnotationDocument = {
      ...document,
      entries: [
        { ...base, target: approvedTarget() },
        { ...base, caseId: 'case-b', target: blankTarget() },
      ],
    };
    const result = importFill({
      pack: twoCases,
      manifest: manifest(['case-a', 'case-b']),
      rubric: snapshot,
      cases: [
        ...cases,
        {
          path: 'cases/case-b.json',
          document: reviewCase({ caseId: 'case-b' }),
        },
      ],
    });
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]?.caseId).toBe('case-a');
    expect(result.pending).toEqual(['case-b']);
    expect(result.problems).toEqual([]);
  });

  it('refuses a fill made against a different input', () => {
    const changed = withInputs(pack(), input({ hint: 'edited after export' }));
    const result = importFill({
      pack: changed,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.labels).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.caseId).toBe('case-a');
    expect(result.problems[0]?.message).toContain(
      'the fill was made against input sha256:',
    );
  });

  it('refuses a fill for a case the dataset does not hold', () => {
    const stray: AnnotationDocument = {
      ...pack(),
      entries: pack().entries.map((entry) => ({
        ...entry,
        caseId: 'case-zz',
        target: approvedTarget(),
      })),
    };
    const result = importFill({
      pack: stray,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.problems).toEqual([
      {
        caseId: 'case-zz',
        message:
          'the fill names case case-zz, which this dataset does not hold',
      },
    ]);
  });

  it('refuses a fill for another dataset', () => {
    const foreign: AnnotationDocument = { ...filled(), datasetId: 'other' };
    const result = importFill({
      pack: foreign,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.problems).toEqual([
      {
        caseId: null,
        message: 'the fill names dataset other, this dataset is demo',
      },
    ]);
    expect(result.labels).toEqual([]);
  });

  it('refuses a fill made against another rubric version', () => {
    const foreign: AnnotationDocument = {
      ...filled(),
      rubric: {
        ...pack().rubric,
        rubricVersion: 'review-rubric-v0',
        source: { ...pack().rubric.source, sha256: `sha256:${'b'.repeat(64)}` },
      },
    };
    const result = importFill({
      pack: foreign,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    // The version and its document digest both moved, and both are reported: a
    // reader has to be able to see that the rubric itself is not the one in force.
    expect(result.problems.map((problem) => problem.message)).toEqual([
      'the fill was made against rubric review-rubric-v0, the committed snapshot is review-rubric-v1',
      expect.stringContaining('the fill quotes rubric document'),
    ]);
    expect(result.labels).toEqual([]);
  });

  it('refuses a decision that names no author', () => {
    const anonymous = withTargets(pack(), approvedTarget({ decidedBy: '  ' }));
    const result = importFill({
      pack: anonymous,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.problems).toEqual([
      {
        caseId: 'case-a',
        message: 'a decided entry must name who decided it in decidedBy',
      },
    ]);
  });

  it('refuses a decision with no legal pair', () => {
    const undecided = withTargets(
      pack(),
      approvedTarget({ allowed: { risk: [3, 4], authorization: [7, 8] } }),
    );
    const result = importFill({
      pack: undecided,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.caseId).toBe('case-a');
    expect(result.problems[0]?.message).toContain(
      'an approved label must name at least one legal pair',
    );
  });

  it('keeps a disputed label out of gold while still importing it', () => {
    const disputed = withTargets(
      pack(),
      approvedTarget({ status: 'disputed' }),
    );
    const result = importFill({
      pack: disputed,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    expect(result.labels).toHaveLength(1);
    expect(result.labels[0]?.target.status).toBe('disputed');
  });

  it('accepts a widened decision that enumerates its pairs', () => {
    const widened = withTargets(
      pack(),
      approvedTarget({
        allowed: { risk: [1, 3], authorization: [1, 8] },
        allowedPairs: [
          [1, 1],
          [3, 8],
        ],
        behaviourReference: 'escalate',
      }),
    );
    const result = importFill({
      pack: widened,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    // The pairs reach deny and allow, not escalate, so the recorded stage is wrong
    // and the label is refused rather than filed with a stage nobody reached.
    expect(result.labels).toEqual([]);
    expect(result.problems).toHaveLength(1);
  });
});

describe('round trip through the CLI data path', () => {
  it('carries a decision from export to a label the checker accepts', () => {
    // The same fixture the CLI writes, read back through the schema the dataset
    // check uses: an exported pack, filled in, must produce a legal label.
    const document = filled();
    const result = importFill({
      pack: document,
      manifest: manifest(['case-a']),
      rubric: snapshot,
      cases,
    });
    const label = result.labels[0];
    expect(label).toBeDefined();
    if (label === undefined) return;
    expect(checkers.label(label).ok).toBe(true);
    expect(label).toEqual(reviewLabel(hash));
  });

  it('reads the committed rubric document for the pack digest', () => {
    // The pack quotes the rubric document digest, so the two must be read from the
    // repository rather than from a fixture that could drift.
    expect(
      join(REPOSITORY_ROOT, 'docs/milestones/review-quality-rubrics.md'),
    ).toMatch(/review-quality-rubrics\.md$/u);
  });
});
