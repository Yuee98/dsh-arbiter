/**
 * The published schemas, and the dataset rules a schema cannot state.
 *
 * Two kinds of claim are pinned here. The schema tests check that a document is
 * accepted or refused on the grounds the contract says — a widened set without its
 * pairs, an approved label with no decision, a model version that disagrees with its
 * stated source. The inspection tests check the rules that span files: a missing
 * case, a moved family, a label whose input no longer hashes to the case.
 */

import { describe, expect, it } from 'vitest';

import { inspectDataset } from '../../evals/src/data/inspect.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { readDataset } from '../../evals/src/data/read.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import {
  VERSIONS,
  approvedTarget,
  caseReviews,
  input,
  manifest,
  modelIdentity,
  opinion,
  reviewCase,
  reviewLabel,
  widenedTarget,
} from './fixtures/documents.js';
import { withDataset } from './helpers/dataset.js';

const checkers = await compileCheckers();
const hash = inputHashOf(input());

describe('case schema', () => {
  it('accepts a well-formed case', () => {
    expect(checkers.case(reviewCase()).ok).toBe(true);
  });

  it('refuses a case carrying an expected score', () => {
    const leaked = { ...reviewCase(), risk: 7, authorization: 9 };
    expect(checkers.case(leaked).ok).toBe(false);
  });

  it('refuses a case with no provenance', () => {
    const { provenance: _omitted, ...withoutProvenance } = reviewCase();
    expect(checkers.case(withoutProvenance).ok).toBe(false);
  });

  it('refuses an unknown provision source', () => {
    const wrong = {
      ...reviewCase(),
      provenance: { ...reviewCase().provenance, source: 'guessed' },
    };
    expect(checkers.case(wrong).ok).toBe(false);
  });
});

describe('label schema', () => {
  it('accepts an approved label', () => {
    expect(checkers.label(reviewLabel(hash)).ok).toBe(true);
  });

  it('accepts a pending label with empty sets', () => {
    const pending = reviewLabel(hash, {
      target: {
        status: 'pending',
        allowed: { risk: [], authorization: [] },
        behaviourReference: null,
        rationale: '',
        decidedBy: '',
        decidedAt: null,
      },
    });
    expect(checkers.label(pending).ok).toBe(true);
  });

  it('refuses an approved label with no decision', () => {
    const undecided = reviewLabel(hash, {
      target: approvedTarget({ rationale: '', decidedBy: '', decidedAt: null }),
    });
    expect(checkers.label(undecided).ok).toBe(false);
  });

  it('refuses an approved label with a score outside the scale', () => {
    // Written as an unknown document, because a hand-edited file is exactly a value
    // the types do not describe until the schema has accepted it.
    const outOfRange: unknown = {
      ...reviewLabel(hash),
      target: {
        ...approvedTarget(),
        allowed: { risk: [0], authorization: [11] },
      },
    };
    expect(checkers.label(outOfRange).ok).toBe(false);
  });

  it('refuses a duplicated score in one set', () => {
    const duplicated = reviewLabel(hash, {
      target: approvedTarget({ allowed: { risk: [7, 7], authorization: [9] } }),
    });
    expect(checkers.label(duplicated).ok).toBe(false);
  });

  it('refuses a bare hash or a hash with no tag', () => {
    expect(checkers.label(reviewLabel('a'.repeat(64))).ok).toBe(false);
    expect(checkers.label(reviewLabel(`sha256:${'a'.repeat(63)}`)).ok).toBe(
      false,
    );
  });
});

describe('reviews schema', () => {
  it('accepts an opinion that leaves a field unanswered', () => {
    const unanswered = caseReviews(hash, {
      reviews: [opinion({ authorization: null })],
    });
    expect(checkers.reviews(unanswered).ok).toBe(true);
  });

  it('refuses a zero standing in for an unanswered field', () => {
    const zero: unknown = {
      ...caseReviews(hash),
      reviews: [{ ...opinion(), risk: 0 }],
    };
    expect(checkers.reviews(zero).ok).toBe(false);
  });

  it('accepts an unknown model version recorded as unknown', () => {
    const unknown = caseReviews(hash, {
      reviews: [
        opinion({
          model: modelIdentity({ version: null, versionSource: 'unknown' }),
        }),
      ],
    });
    expect(checkers.reviews(unknown).ok).toBe(true);
  });
});

describe('manifest schema', () => {
  it('accepts a manifest of one family', () => {
    expect(checkers.manifest(manifest(['case-a'])).ok).toBe(true);
  });

  it('refuses a split outside the three the contract names', () => {
    const wrongSplit: unknown = {
      ...manifest(['case-a']),
      families: [{ familyId: 'fam-a', split: 'train' }],
    };
    expect(checkers.manifest(wrongSplit).ok).toBe(false);
  });
});

describe('dataset inspection', () => {
  it('accepts a coherent dataset', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write('labels/case-a.json', reviewLabel(hash));
      await dataset.write('reviews/case-a.json', caseReviews(hash));
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems).toEqual([]);
      expect(inspection.labels.gold).toHaveLength(1);
      expect(inspection.findings).toEqual([]);
    });
  });

  it('reports a case the manifest does not declare', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest([]));
      await dataset.write('cases/case-a.json', reviewCase());
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          'case case-a is not declared in manifest.json',
        ]),
      );
    });
  });

  it('reports a case whose family owns another split', async () => {
    await withDataset(async (dataset) => {
      await dataset.write(
        'manifest.json',
        manifest(['case-a'], {
          families: [{ familyId: 'fam-a', split: 'holdout' }],
        }),
      );
      await dataset.write('cases/case-a.json', reviewCase());
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          'case case-a claims split dev but family fam-a is assigned holdout',
        ]),
      );
    });
  });

  it('reports a label whose input changed', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write(
        'cases/case-a.json',
        reviewCase({ input: input({ hint: 'changed after labelling' }) }),
      );
      await dataset.write('labels/case-a.json', reviewLabel(hash));
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.labels.gold).toEqual([]);
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('this label cannot count (input-changed)'),
        ]),
      );
    });
  });

  it('reports a review file recorded against another input', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'reviews/case-a.json',
        caseReviews(`sha256:${'0'.repeat(64)}`),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          expect.stringMatching(/^reviews were recorded against input /u),
        ]),
      );
    });
  });

  it('reports a document filed under a name that is not its id', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write(
        'cases/case-b.json',
        reviewCase({ caseId: 'case-a' }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          "case file case-b declares id case-a; a document's file name is its id",
        ]),
      );
    });
  });

  it('reports an unparsable file with the file it came from', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      const { writeFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      await writeFile(join(dataset.path, 'cases/case-b.json'), '{ "caseId": }');
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems).toHaveLength(1);
      expect(inspection.problems[0]?.path).toBe('cases/case-b.json');
    });
  });

  it('reports an approved label that enumerates no pairs for a widened set', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'labels/case-a.json',
        reviewLabel(hash, {
          target: approvedTarget({
            allowed: { risk: [7, 8], authorization: [9] },
          }),
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('must name at least one legal pair'),
        ]),
      );
    });
  });

  it('reports an enumerated pair outside the allowed sets', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'labels/case-a.json',
        reviewLabel(hash, {
          target: approvedTarget({
            allowed: { risk: [7], authorization: [9] },
            allowedPairs: [[7, 10]],
          }),
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          'allowed pair 7/10 is outside the allowed sets',
        ]),
      );
    });
  });

  it('reports a behaviour reference no legal pair reaches', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'labels/case-a.json',
        reviewLabel(hash, {
          target: approvedTarget({ behaviourReference: 'deny' }),
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          'behaviour reference deny is not reachable from the legal pairs (escalate)',
        ]),
      );
    });
  });

  it('notes a model version recorded without its source', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'reviews/case-a.json',
        caseReviews(hash, {
          reviews: [
            opinion({
              model: modelIdentity({
                version: null,
                versionSource: 'provider-reported',
              }),
            }),
          ],
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('has no model version but claims source'),
        ]),
      );
    });
  });

  it('reports a model that disagrees as a note, never as a label change', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      const label = reviewLabel(hash);
      await dataset.write('labels/case-a.json', label);
      await dataset.write(
        'reviews/case-a.json',
        caseReviews(hash, {
          reviews: [opinion({ risk: 3, authorization: 8 })],
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems).toEqual([]);
      expect(inspection.findings.map((finding) => finding.message)).toEqual([
        'review review-1 reaches allow at 3/8; the reference for case-a is escalate',
      ]);
      // The human reference is untouched by the disagreement.
      expect(inspection.labels.gold[0]?.label).toEqual(label);
    });
  });

  it('requires a manifest', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('cases/case-a.json', reviewCase());
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(inspection.problems.map((problem) => problem.message)).toContain(
        'a dataset needs a manifest.json matching manifest.schema.json',
      );
    });
  });

  it('refuses a widened set whose pairs disagree about the stage', async () => {
    await withDataset(async (dataset) => {
      await dataset.write('manifest.json', manifest(['case-a']));
      await dataset.write('cases/case-a.json', reviewCase());
      await dataset.write(
        'labels/case-a.json',
        reviewLabel(hash, {
          // 1/1 is a prohibition and 3/8 is complete coverage, so the two pairs
          // reach different stages; one label cannot record both.
          target: widenedTarget([
            [1, 1],
            [3, 8],
          ] as const),
        }),
      );
      const inspection = inspectDataset(
        await readDataset(dataset.path),
        checkers,
      );
      expect(
        inspection.problems.some(
          (problem) =>
            problem.message.includes('is not reachable from the legal pairs') &&
            problem.message.includes('deny') &&
            problem.message.includes('allow'),
        ),
      ).toBe(true);
    });
  });
});

describe('committed versions', () => {
  it('names the same versions the fixtures use', () => {
    // A drift here would make every committed label stale, so the fixture versions
    // are pinned against the contract constant the code reads.
    expect(VERSIONS.contract).toBe('review-contract-v1');
  });
});
