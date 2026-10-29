/**
 * The rubric snapshot and the versions a label is bound to.
 *
 * The snapshot is committed data, so the risk is that it silently stops describing
 * the contract it claims to. These tests pin the two outcomes: a drifted band is a
 * problem, and a wording-only edit to the source document is a note.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  AUTHORIZATION_BANDS,
  RISK_BANDS,
} from '../../src/review-contract/index.js';
import { checkSnapshot } from '../../evals/src/data/rubric.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { sha256Text } from '../../evals/src/data/hash.js';
import { REPOSITORY_ROOT } from './helpers/dataset.js';
import type { RubricSnapshot } from '../../evals/src/data/types.js';

const checkers = await compileCheckers();

/** Require a deliberately malformed document to still be the snapshot shape. */
function asSnapshot(value: unknown): RubricSnapshot {
  const checked = checkers.rubric(value);
  // The malformed cases here are malformed in ways the schema does not describe,
  // so they still pass it; a document the schema refuses is a different test.
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return checked.document;
}

async function committed(): Promise<{
  snapshot: RubricSnapshot;
  document: string;
}> {
  const raw: unknown = JSON.parse(
    await readFile(
      join(REPOSITORY_ROOT, 'evals/rubrics/rubric-v1.json'),
      'utf8',
    ),
  );
  const checked = checkers.rubric(raw);
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return {
    snapshot: checked.document,
    document: await readFile(
      join(REPOSITORY_ROOT, 'docs/milestones/review-quality-rubrics.md'),
      'utf8',
    ),
  };
}

describe('committed rubric snapshot', () => {
  it('matches its schema', async () => {
    const { snapshot } = await committed();
    expect(snapshot.rubricVersion).toBe('review-rubric-v1');
    expect(snapshot.contractVersion).toBe('review-contract-v1');
  });

  it('records the same ten risk bands as the contract', async () => {
    const { snapshot } = await committed();
    expect(snapshot.risk).toEqual(
      RISK_BANDS.map((band) => ({
        score: band.score,
        criterion: band.criterion,
      })),
    );
  });

  it('records the same ten authorization bands as the contract', async () => {
    const { snapshot } = await committed();
    expect(snapshot.authorization).toEqual(
      AUTHORIZATION_BANDS.map((band) => ({
        score: band.score,
        criterion: band.criterion,
      })),
    );
  });

  it('matches the rubric document currently in the repository', async () => {
    const { snapshot, document } = await committed();
    expect(snapshot.source.sha256).toBe(sha256Text(document));
  });

  it('passes its own check with no problems and no findings', async () => {
    const { snapshot, document } = await committed();
    const result = checkSnapshot(snapshot, document);
    expect(result.problems).toEqual([]);
    expect(result.findings).toEqual([]);
  });
});

describe('snapshot drift', () => {
  it('reports a band whose wording changed in the contract', async () => {
    const { snapshot, document } = await committed();
    const drifted: RubricSnapshot = {
      ...snapshot,
      risk: snapshot.risk.map((band, index) =>
        index === 0 ? { ...band, criterion: 'nothing bad happens' } : band,
      ),
    };
    const result = checkSnapshot(drifted, document);
    expect(result.problems).toEqual([
      expect.stringContaining('at score 1 reads "nothing bad happens"'),
    ]);
  });

  it('reports a snapshot with a missing band rather than reading it as a nine-band scale', async () => {
    const { snapshot, document } = await committed();
    const shortened: RubricSnapshot = {
      ...snapshot,
      authorization: snapshot.authorization.slice(0, 9),
    };
    expect(checkSnapshot(shortened, document).problems).toEqual([
      expect.stringContaining('has 9 bands, the contract has 10'),
    ]);
  });

  it('reports a moved order, which would rename every band', async () => {
    const { snapshot, document } = await committed();
    const reordered: RubricSnapshot = {
      ...snapshot,
      risk: [...snapshot.risk].reverse(),
    };
    const result = checkSnapshot(reordered, document);
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('notes a changed source document without failing the check', async () => {
    const { snapshot } = await committed();
    const result = checkSnapshot(snapshot, 'a rewritten rubric document');
    expect(result.problems).toEqual([]);
    expect(result.findings).toEqual([
      expect.stringContaining('changed since the snapshot was recorded'),
    ]);
  });
});

describe('snapshot schema', () => {
  it('refuses a snapshot with a duplicated band score', async () => {
    const { snapshot } = await committed();
    const duplicated: unknown = {
      ...snapshot,
      risk: snapshot.risk.map((band, index) =>
        index === 1 ? { ...band, score: 1 } : band,
      ),
    };
    // The schema pins the length, and the band comparison pins the contents, so a
    // repeated score is caught where it matters rather than by uniqueItems.
    const result = checkSnapshot(asSnapshot(duplicated), 'irrelevant');
    expect(result.problems.length).toBeGreaterThan(0);
  });

  it('refuses a snapshot with no source digest', async () => {
    const { snapshot } = await committed();
    const { source: _omitted, ...rest } = snapshot;
    expect(checkers.rubric(rest).ok).toBe(false);
  });
});
