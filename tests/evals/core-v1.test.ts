/**
 * The published core-v1 dataset, checked as data.
 *
 * `pnpm check:evals` already proves the dataset is internally consistent: the
 * manifest names the cases, each family owns one split, and no case carries an
 * answer. That check cannot see the two claims this task is actually accepted on:
 * that the set covers every band and every adjacent boundary, and that the
 * annotation pack handed to the labelling window is exactly the pack the tool
 * exports from these cases.
 *
 * Those are asserted here, against the committed files. Nothing is regenerated and
 * nothing is mocked: a test that rebuilt the dataset would prove the generator works
 * while leaving the published data free to drift from it.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  auditPack,
  buildAnnotationPack,
  isBlankTarget,
} from '../../evals/src/annotation/export.js';
import { inspectDataset } from '../../evals/src/data/inspect.js';
import { inputHashOf } from '../../evals/src/data/eligibility.js';
import { readDataset } from '../../evals/src/data/read.js';
import { checkSnapshot } from '../../evals/src/data/rubric.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import type {
  AnnotationDocument,
  DatasetManifest,
  ReviewCase,
  ReviewLabel,
  RubricSnapshot,
} from '../../evals/src/data/types.js';
import { REVIEW_CONTRACT_VERSION } from '../../src/review-contract/index.js';
import { readDocument, schemas } from './helpers/documents.js';
import { REPOSITORY_ROOT } from './helpers/dataset.js';

const DATASET = 'evals/datasets/core-v1';
const PACK = 'evals/annotation-pack/core-v1.pack.json';
const COVERAGE = `${DATASET}/COVERAGE.md`;

/** Read every `.json` file in one dataset directory, in name order. */
async function jsonFiles(directory: string): Promise<readonly string[]> {
  const names = (await readdir(join(REPOSITORY_ROOT, directory))).filter(
    (name) => name.endsWith('.json'),
  );
  return [...names].sort((left, right) => left.localeCompare(right));
}

const manifest = await readDocument<DatasetManifest>(
  join(REPOSITORY_ROOT, DATASET, 'manifest.json'),
  schemas.manifest,
);

const cases: readonly ReviewCase[] = await Promise.all(
  (await jsonFiles(`${DATASET}/cases`)).map((name) =>
    readDocument<ReviewCase>(
      join(REPOSITORY_ROOT, DATASET, 'cases', name),
      schemas.case,
    ),
  ),
);

const pack = await readDocument<AnnotationDocument>(
  join(REPOSITORY_ROOT, PACK),
  schemas.annotation,
);

const coverage = await readFile(join(REPOSITORY_ROOT, COVERAGE), 'utf8');

/**
 * One markdown table row, split into trimmed cells.
 *
 * Prettier pads table cells to a common width, so a row is matched by its cells
 * rather than by its spacing: a test that compared literal prefixes would break the
 * first time the file was formatted.
 */
function tableRow(line: string): readonly string[] | null {
  if (!line.trimStart().startsWith('|')) return null;
  const cells = line.trim().split('|');
  // A row has one leading and one trailing separator, which produce empty cells.
  if (cells.length < 3) return null;
  return cells.slice(1, -1).map((cell) => cell.trim());
}

/** Every table row in one part of the ledger. */
function ledgerRows(section: string): readonly (readonly string[])[] {
  const rows: (readonly string[])[] = [];
  for (const line of section.split('\n')) {
    const cells = tableRow(line);
    if (cells !== null) rows.push(cells);
  }
  return rows;
}

/** The committed rubric snapshot, the same document the dataset is labelled against. */
const rubric: RubricSnapshot = await readDocument<RubricSnapshot>(
  join(REPOSITORY_ROOT, 'evals/rubrics/rubric-v1.json'),
  schemas.rubric,
);

const caseById = new Map(cases.map((entry) => [entry.caseId, entry] as const));

describe('core-v1 dataset', () => {
  it('publishes the pilot set the issue asks for', () => {
    // The design names 30-50 as the first stage. Pinning the range keeps a later
    // batch from silently shrinking the set, without freezing the exact count that
    // the gap plan is allowed to grow.
    expect(cases.length).toBeGreaterThanOrEqual(30);
    expect(cases.length).toBeLessThanOrEqual(50);
    expect(manifest.cases).toHaveLength(cases.length);
    expect(manifest.datasetId).toBe('core-v1');
  });

  it('declares the versions its labels will be made under', () => {
    expect(manifest.versions.contract).toBe(REVIEW_CONTRACT_VERSION);
    expect(manifest.versions.rubric).toBe(rubric.rubricVersion);
    // The policy version belongs to the production task; the dataset only has to
    // name the one in force rather than inventing a fourth.
    expect(manifest.versions.policy).toBe('arbiter-policy-v2');
  });

  it('passes the same inspection `pnpm check:evals` runs', async () => {
    const inspection = inspectDataset(
      await readDataset(join(REPOSITORY_ROOT, DATASET)),
      await compileCheckers(),
      {
        contract: REVIEW_CONTRACT_VERSION,
        rubric: rubric.rubricVersion,
      },
    );
    expect(inspection.problems).toEqual([]);
    expect(inspection.manifest).not.toBeNull();
  });

  it('carries no gold label and no model opinion yet', async () => {
    // This task hands over material to label, not a labelled dataset. If a labels
    // or reviews directory appears here without the annotation window having run,
    // the dataset is claiming an adjudication nobody made.
    expect(await jsonFiles(`${DATASET}/labels`).catch(() => [])).toEqual([]);
    expect(await jsonFiles(`${DATASET}/reviews`).catch(() => [])).toEqual([]);
  });
});

describe('core-v1 provenance', () => {
  it('uses only the three declared sources', () => {
    const sources = new Set(cases.map((entry) => entry.provenance.source));
    expect([...sources].sort()).toEqual(['real', 'reconstructed', 'synthetic']);
  });

  it('says where every case came from', () => {
    for (const entry of cases) {
      expect(entry.provenance.origin.trim().length).toBeGreaterThan(0);
      expect(entry.provenance.collectedAt).toMatch(
        /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/,
      );
    }
  });

  it('does not overstate how much of the set is real', () => {
    // The design allows real material "where it exists". Reporting one real case as
    // anything but a small minority would misrepresent the set, so the count is
    // pinned: it can grow, but the ratio has to stay honest.
    const real = cases.filter((entry) => entry.provenance.source === 'real');
    expect(real.length).toBeGreaterThanOrEqual(1);
    expect(real.length).toBeLessThan(cases.length / 2);
  });

  it('records on the real case what was changed', () => {
    // A real record edited for publication must say so; otherwise "real" reads as
    // "unmodified transcript", which would be false.
    for (const entry of cases.filter(
      (item) => item.provenance.source === 'real',
    )) {
      expect(entry.provenance.notes ?? '').toMatch(
        /替换|重写|removed|replaced/i,
      );
      expect(JSON.stringify(entry.input)).not.toMatch(/\/Users\/|\/Volumes\//);
    }
  });
});

describe('core-v1 family isolation', () => {
  it('assigns every split through a family', () => {
    const splitOf = new Map(
      manifest.families.map(
        (family) => [family.familyId, family.split] as const,
      ),
    );
    for (const entry of cases) {
      expect(splitOf.get(entry.familyId)).toBe(entry.split);
    }
  });

  it('keeps variants of one family on one side of every boundary', () => {
    // The whole point of assigning splits per family: a single-factor variant may
    // never be half in dev and half in holdout.
    const splitsPerFamily = new Map<string, Set<string>>();
    for (const entry of cases) {
      const seen = splitsPerFamily.get(entry.familyId) ?? new Set<string>();
      seen.add(entry.split);
      splitsPerFamily.set(entry.familyId, seen);
    }
    for (const [familyId, splits] of splitsPerFamily) {
      expect([...splits], `family ${familyId}`).toHaveLength(1);
    }
  });

  it('uses all three splits', () => {
    const splits = new Set(cases.map((entry) => entry.split));
    expect([...splits].sort()).toEqual(['calibration', 'dev', 'holdout']);
  });

  it('keeps the band-by-band ladder in the calibration split', () => {
    // A family that walks A1..A10 is how the calibration set is tuned. Reusing it
    // as a holdout would mean the holdout was used to decide the thresholds it is
    // supposed to test.
    const ladder = cases.filter(
      (entry) => entry.familyId === 'cal-authorization-ladder',
    );
    expect(ladder.length).toBe(11);
    for (const entry of ladder) expect(entry.split).toBe('calibration');
  });
});

describe('core-v1 coverage', () => {
  it('covers all nine non-degenerate risk bands', () => {
    // The committed material never states an expected band, so coverage is read off
    // the ledger instead: a band whose row is missing or holds no case is the gap
    // this test exists to catch.
    const rows = ledgerRows(coverage.split('### 5.1 风险十档')[1] ?? '');
    for (let score = 1; score <= 10; score += 1) {
      const row = rows.find((cells) => cells[0] === String(score));
      expect(row, `risk band ${String(score)} has no row`).toBeDefined();
      expect(row?.[1], `risk band ${String(score)} is uncovered`).not.toBe('0');
      expect(row?.[2], `risk band ${String(score)} is uncovered`).not.toContain(
        '未覆盖',
      );
    }
  });

  it('covers all nine non-degenerate authorization bands plus the prohibition', () => {
    // Authorization has the same ten rows but a different shape: band 1 is a
    // prohibition rather than the bottom of a positive scale, so "covered" means a
    // case where an applicable prohibition is in force.
    const rows = ledgerRows(coverage.split('### 5.2 授权十档')[1] ?? '');
    for (let score = 1; score <= 10; score += 1) {
      const row = rows.find((cells) => cells[0] === String(score));
      expect(
        row,
        `authorization band ${String(score)} has no row`,
      ).toBeDefined();
      expect(
        row?.[1],
        `authorization band ${String(score)} is uncovered`,
      ).not.toBe('0');
      expect(
        row?.[2],
        `authorization band ${String(score)} is uncovered`,
      ).not.toContain('未覆盖');
    }
  });

  it('names an existing case in every ledger row', () => {
    // A ledger that points at a renamed or deleted case is worse than no ledger: it
    // reads as coverage while covering nothing. Only the mapping rows are checked —
    // prose elsewhere legitimately names source kinds and field names in backticks.
    const rows = ledgerRows(coverage).filter((cells) =>
      /^(?:[0-9]{1,2}|(?:R|A)\d+\/\d+)$/u.test(cells[0] ?? ''),
    );
    expect(rows.length).toBeGreaterThan(0);
    const named = rows.flatMap((cells) =>
      [...cells.join(' ').matchAll(/`([^`]+)`/gu)].map(
        (match) => match[1] ?? '',
      ),
    );
    const unknown = [...new Set(named)].filter(
      (candidate) => !caseById.has(candidate),
    );
    expect(unknown).toEqual([]);
  });

  it('documents every adjacent boundary the task singles out', () => {
    // The issue names A1/2, 7/8, 8/9, 9/10 and R2/3, 4/5, 6/7 explicitly. The ledger
    // covers all eighteen boundaries; these seven are the ones a reader must be able
    // to find without searching.
    for (const boundary of [
      'A1/2',
      '7/8',
      '8/9',
      '9/10',
      'R2/3',
      'R4/5',
      'R6/7',
    ]) {
      expect(coverage, `boundary ${boundary}`).toContain(boundary);
    }
  });

  it('pairs both sides of every documented boundary with real cases', () => {
    // Each boundary row is `| code | direction | low cases | high cases |`. Both
    // sides have to name at least one committed case, otherwise the "boundary" is a
    // single point rather than a comparison.
    const rows = ledgerRows(coverage).filter((cells) =>
      /^(?:R\d+\/\d+|A\d+\/\d+)$/u.test(cells[0] ?? ''),
    );
    expect(rows.length).toBeGreaterThanOrEqual(18);
    for (const cells of rows) {
      const code = cells[0];
      const low = [...(cells[2] ?? '').matchAll(/`([^`]+)`/gu)].map(
        (match) => match[1],
      );
      const high = [...(cells[3] ?? '').matchAll(/`([^`]+)`/gu)].map(
        (match) => match[1],
      );
      expect(low.length, `${String(code)} low side`).toBeGreaterThan(0);
      expect(high.length, `${String(code)} high side`).toBeGreaterThan(0);
      for (const caseId of [...low, ...high]) {
        expect(
          caseById.has(caseId ?? ''),
          `${String(code)} names ${String(caseId)}`,
        ).toBe(true);
      }
    }
  });

  it('states the scale it is part of rather than only the pilot count', () => {
    // The design's numbers are workload guidance, so the ledger has to publish both
    // the delivered size and the planned ones instead of quietly treating 50 as the
    // finished dataset.
    expect(coverage).toContain('100–150');
    expect(coverage).toContain('600');
  });
});

describe('core-v1 required shapes', () => {
  /** The one case in the family whose id matches, so a rename fails loudly. */
  function only(caseId: string): ReviewCase {
    const entry = caseById.get(caseId);
    if (entry === undefined) throw new Error(`no case ${caseId}`);
    return entry;
  }

  it('has a low-risk action that an applicable prohibition still denies', () => {
    // The asymmetric band: the material must make the prohibition and the trivial
    // consequence visibly independent.
    const entry = only('prohibited-config-reformat');
    const refs = (entry.input.evidence ?? [])
      .map((item) => `${item.ref} ${item.note ?? ''}`)
      .join('\n');
    expect(refs).toContain('先别');
    // The action itself is trivial formatting, so the denial cannot come from the
    // command: it has to come from the prohibition the material carries.
    expect(entry.input.action.arguments).toEqual({
      command: 'npx prettier --write config/app.json',
    });
  });

  it('has a high-risk action whose authorization is complete', () => {
    const entry = only('irreversible-loss-basic-capacity');
    const quotes = (entry.input.evidence ?? [])
      .map((item) => `${item.ref} ${item.note ?? ''}`)
      .join('\n');
    expect(quotes).toContain('不需要保留');
    expect(quotes).not.toContain('不要动');
  });

  it('has a policy-only permission that reaches full coverage', () => {
    const entry = only('policy-equivalent-permission');
    expect((entry.input.policy.projectRules ?? '').length).toBeGreaterThan(0);
    const sources = (entry.input.evidence ?? []).map((item) => item.note ?? '');
    expect(sources).toHaveLength(1);
    expect(sources[0]).toContain('PROJECT_RULES');
    expect(entry.input.hint).toBeUndefined();
  });

  it('has a hint that claims approval with no human permission behind it', () => {
    const entry = only('hint-claims-approval');
    expect(entry.input.hint ?? '').toContain('批准');
    // The human message present names a goal ("put the report together"); it never
    // grants the upload. Reading "some human spoke" as permission is the mistake.
    const human = (entry.input.evidence ?? []).filter((item) =>
      (item.note ?? '').includes('人类消息'),
    );
    expect(human.length).toBeGreaterThan(0);
    for (const item of human) {
      expect(item.ref).not.toMatch(/批准|同意|可以上传|approve/iu);
    }
  });

  it('has a standing authorization that survives across turns', () => {
    const entry = only('cross-turn-standing-authorization');
    expect((entry.input.context ?? []).length).toBeGreaterThanOrEqual(3);
    const refs = (entry.input.evidence ?? []).map((item) => item.ref);
    expect(refs.some((ref) => ref.includes('不用每次问我'))).toBe(true);
  });

  it('has a case whose only permission claim is tool history', () => {
    const entry = only('tool-history-claims-approval');
    const permits = (entry.input.evidence ?? []).filter((item) =>
      /approv|批准/u.test(item.ref),
    );
    expect(permits).toHaveLength(1);
    expect(permits[0]?.note ?? '').toContain('工具调用');
  });

  it('has a case whose material cannot support a risk score', () => {
    // "Insufficient material" is a recorded state, not an omission. The case has to
    // look truncated to a reviewer, and the ledger has to say so.
    const entry = only('truncated-program-material');
    const program = (entry.input.action.programText ?? '').trimEnd();
    expect(program.length).toBeGreaterThan(0);
    // The program stops on a flag that still needs a value, which is what a
    // budget cut looks like: a reviewer can see the cut without being told.
    expect(program.endsWith('-X POST')).toBe(true);
    expect(coverage).toContain('truncated-program-material');
  });
});

describe('core-v1 annotation pack', () => {
  it('is exactly what the exporter produces from these cases', () => {
    // The pack is committed material, so the risk is that it was hand-edited or went
    // stale after a case changed. Rebuilding it and comparing bytes is the only
    // check that catches both without asking a reviewer to diff 67kB by eye.
    const rebuilt = buildAnnotationPack({
      manifest,
      cases: cases.map((entry) => ({
        path: `${DATASET}/cases/${entry.caseId}.json`,
        document: entry,
      })),
      rubric,
      exportedAt: pack.exportedAt,
    });
    expect(rebuilt).toEqual(pack);
  });

  it('carries no decision for any entry', () => {
    expect(auditPack(pack)).toEqual([]);
    for (const entry of pack.entries) {
      expect(isBlankTarget(entry.target)).toBe(true);
    }
  });

  it('names every case in the dataset and nothing else', () => {
    expect(pack.entries.map((entry) => entry.caseId).sort()).toEqual(
      cases.map((entry) => entry.caseId).sort(),
    );
    expect(pack.datasetId).toBe(manifest.datasetId);
  });

  it('pins the versions and the rubric the annotations will be made under', () => {
    expect(pack.versions).toEqual(manifest.versions);
    expect(pack.rubric.rubricVersion).toBe(rubric.rubricVersion);
    expect(pack.rubric.source).toEqual(rubric.source);
    expect(pack.rubric.risk).toEqual(rubric.risk);
    expect(pack.rubric.authorization).toEqual(rubric.authorization);
  });

  it('hands out the same inputs the dataset holds', () => {
    // A pack whose input differs from the case is a decision waiting to be made
    // against the wrong material, and `import` would refuse it much later.
    for (const entry of pack.entries) {
      const source = caseById.get(entry.caseId);
      if (source === undefined) {
        throw new Error(`the pack names ${entry.caseId}, the dataset does not`);
      }
      expect(inputHashOf(entry.input)).toBe(inputHashOf(source.input));
      expect(entry.split).toBe(source.split);
      expect(entry.familyId).toBe(source.familyId);
    }
  });

  it('publishes the rubric bands the contract actually defines', async () => {
    // The snapshot travels with the pack so a person can grade offline. A drifted
    // snapshot would have them grading against bands the repository no longer uses.
    const document = await readFile(
      join(REPOSITORY_ROOT, 'docs/milestones/review-quality-rubrics.md'),
      'utf8',
    );
    expect(checkSnapshot(rubric, document).problems).toEqual([]);
  });
});

describe('core-v1 ledger', () => {
  it('says the pack is not part of it', () => {
    // The ledger states each case's design target. That is deliberately outside the
    // pack, and the ledger has to say so or an annotator could read it as the answer.
    expect(coverage).toContain('不是答案');
    expect(coverage).toContain('终审');
  });

  it('separates engineering fixtures from model-semantic cases', () => {
    // The design requires the two to be counted apart. The ledger must name the
    // existing fixture set rather than merging it into this dataset's count.
    expect(coverage).toContain('54');
    expect(coverage).toContain('policy-calibration');
  });

  it('publishes the gaps rather than only the achievements', () => {
    expect(coverage).toContain('缺口');
    for (const gap of ['A5', 'A6', '真实来源']) {
      expect(coverage, `gap ${gap}`).toContain(gap);
    }
  });
});

describe('core-v1 case documents', () => {
  it('never carries an answer-shaped key', () => {
    // The schema already refuses unknown properties; this restates the property that
    // matters in the vocabulary a reviewer of this task uses, so a future schema
    // relaxation cannot quietly start accepting a leaked answer.
    const forbidden = ['target', 'label', 'allowed', 'risk', 'authorization'];
    for (const entry of cases) {
      const keys: readonly string[] = Object.keys(entry);
      for (const key of forbidden) {
        expect(keys.includes(key), `${entry.caseId} carries ${key}`).toBe(
          false,
        );
      }
    }
  });

  it('keeps every label file out of the dataset until the window runs', async () => {
    // `readDataset` treats a missing directory as "no labels", which is the normal
    // interim state. This asserts the earlier claim from the other direction.
    const labels = await jsonFiles(`${DATASET}/labels`).catch(() => []);
    const parsed: readonly ReviewLabel[] = await Promise.all(
      labels.map((name) =>
        readDocument<ReviewLabel>(
          join(REPOSITORY_ROOT, DATASET, 'labels', name),
          schemas.label,
        ),
      ),
    );
    expect(parsed).toEqual([]);
    const reviews = await jsonFiles(`${DATASET}/reviews`).catch(() => []);
    expect(reviews).toEqual([]);
  });
});
