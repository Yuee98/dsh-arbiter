import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  parseVariants,
  resolveVariant,
  REPLAY_VARIANTS_VERSION,
} from '../../evals/src/replay/index.js';
import { withArea } from './helpers/report-run.js';
import { readSource } from '../../evals/src/replay/source.js';
import { recordPathOf } from '../../evals/src/run/artifact.js';
import { replayRunIdOf } from '../../evals/src/replay/assemble.js';
import { REPOSITORY_ROOT } from './helpers/report-run.js';
import {
  CASES,
  cellRecordOf,
  chatRun,
  chatText,
  chatCellOf,
  decisionRun,
  decisionCellOf,
  decisionForCase,
  inventory,
  replay,
  readJson,
  objectsAt,
  numberAt,
  textAt,
} from './helpers/replay.js';

const matrix = {
  id: 'authorization-nine',
  requiredAuthorization: [2, 2, 9, 9, 9, 9, 10, 10, 10, 10],
};
const variant = resolveVariant({ matrix });
if (typeof variant === 'string') throw new Error(variant);

describe('authored matrices are a separate offline replay axis', () => {
  it('keeps long-label identity stable and distinct across complete axes and sources', () => {
    const candidates = [
      { matrix },
      { matrix, thresholds: { risk: 'at-least' } },
      { matrix, settlement: { mode: 'no-ask' } },
      { matrix, answer: 'recorded-parse' },
    ] as const;
    const ids = candidates.map((stated) => {
      const selected = resolveVariant(stated);
      if (typeof selected === 'string') throw new Error(selected);
      const id = replayRunIdOf('source-one', selected.variantId);
      expect(id).toMatch(/^[a-z0-9-]{1,63}$/);
      expect(replayRunIdOf('source-one', selected.variantId)).toBe(id);
      return id;
    });
    expect(new Set(ids).size).toBe(candidates.length);
    const sources = [
      'source-one',
      'source-two',
      'a'.repeat(62) + 'b',
      'a'.repeat(62) + 'c',
    ];
    expect(
      new Set(sources.map((source) => replayRunIdOf(source, variant.variantId)))
        .size,
    ).toBe(sources.length);
  });
  it('refuses workflow-marked records without their frozen workflow plan', async () => {
    await withArea(async (area) => {
      const first = CASES[0],
        second = CASES[1];
      if (first === undefined || second === undefined)
        throw new Error('case missing');
      const run = await chatRun(await area.dir('source'), [
        { cellId: chatCellOf(first), text: chatText(3, 8) },
        { cellId: chatCellOf(second), text: chatText(3, 8) },
      ]);
      const record = await cellRecordOf(run, chatCellOf(first));
      await writeFile(
        join(run, recordPathOf(record.cellId)),
        JSON.stringify({
          ...record,
          workflow: {
            group: 'synthetic',
            rootId: 'root',
            lineageId: 'lineage',
            pointId: 'point',
            viewId: 'view',
          },
        }),
      );
      const source = await readSource({
        directory: run,
        root: REPOSITORY_ROOT,
      });
      expect(source).toMatchObject({
        ok: false,
        problems: [expect.stringContaining('frozen workflow plan')],
      });
    });
  });
  it('keeps old defaults and identifies table content independently of its name', () => {
    const baseline = resolveVariant({});
    expect(
      resolveVariant({
        matrix: {
          id: 'explicit-default',
          requiredAuthorization: [2, 2, 8, 8, 9, 9, 10, 10, 10, 10],
        },
      }),
    ).toEqual(baseline);
    const renamed = resolveVariant({ matrix: { ...matrix, id: 'other-name' } });
    if (typeof renamed === 'string') throw new Error(renamed);
    expect(renamed.digest).toBe(variant.digest);
    expect(
      parseVariants({
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }, { matrix: { ...matrix, id: 'other-name' } }],
      }).ok,
    ).toBe(false);
    const changed = resolveVariant({
      matrix: {
        ...matrix,
        requiredAuthorization: [2, 2, 8, 9, 9, 9, 10, 10, 10, 10],
      },
    });
    if (typeof changed === 'string') throw new Error(changed);
    expect(changed.digest).not.toBe(variant.digest);
    expect(changed.variantId).not.toBe(variant.variantId);
  });

  it.each(['../source', 'x/y', 'x\\y', '.', 'Upper', 'a'.repeat(64)])(
    'refuses unsafe matrix id %s',
    (id) => {
      expect(typeof resolveVariant({ matrix: { ...matrix, id } })).toBe(
        'string',
      );
    },
  );

  it('changes verdict and authorization demand separately while preserving source bytes', async () => {
    await withArea(async (area) => {
      const first = CASES[0],
        second = CASES[1];
      if (first === undefined || second === undefined)
        throw new Error('case missing');
      const run = await chatRun(await area.dir('source'), [
        { cellId: chatCellOf(first), text: chatText(3, 8) },
        { cellId: chatCellOf(second), text: chatText(3, 2) },
      ]);
      const original = await inventory(run);
      await area.write('variants.json', {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }],
      });
      const output = await area.dir('derived');
      const result = await replay({
        directory: run,
        output,
        variants: join(area.path, 'variants.json'),
      });
      expect(result.code).toBe(0);
      const directory = join(output, variant.variantId);
      expect(
        (await cellRecordOf(directory, chatCellOf(first))).outcome,
      ).toMatchObject({
        risk: 3,
        authorization: 8,
        requiredAuthorization: 9,
        verdict: 'review-escalate',
      });
      const lineage = await readJson(join(directory, 'lineage.json'));
      const rows = objectsAt(lineage, 'cells');
      expect(numberAt(lineage, 'totals.changed')).toBe(2);
      expect(rows.map((row) => row['stored'])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorization: 2,
            requiredAuthorization: 8,
            verdict: 'review-escalate',
          }),
        ]),
      );
      expect(rows.map((row) => row['derived'])).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            authorization: 2,
            requiredAuthorization: 9,
            verdict: 'review-escalate',
          }),
        ]),
      );
      expect(await inventory(run)).toEqual(original);
    });
  });

  it('applies the same candidate to native decision scores under default N0', async () => {
    await withArea(async (area) => {
      const id = decisionCellOf('read-named-source-file');
      const run = await decisionRun(await area.dir('source'), {
        [id]: decisionForCase({ '2': 1 }, { '7': 1 }),
      });
      await area.write('variants.json', {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }],
      });
      const output = await area.dir('derived');
      expect(
        (
          await replay({
            directory: run,
            output,
            variants: join(area.path, 'variants.json'),
          })
        ).code,
      ).toBe(0);
      expect(
        (await cellRecordOf(join(output, variant.variantId), id)).outcome,
      ).toMatchObject({
        risk: 3,
        authorization: 8,
        requiredAuthorization: 9,
        verdict: 'review-escalate',
      });
    });
  });
  it('records matrix-only, N0-only and joint changes independently', async () => {
    await withArea(async (area) => {
      const id = decisionCellOf('read-named-source-file');
      const run = await decisionRun(await area.dir('source'), {
        [id]: decisionForCase({ '2': 0.5, '3': 0.5 }, { '7': 1 }),
      });
      const document = {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [
          {},
          { matrix },
          { thresholds: { risk: 'at-least' } },
          { matrix, thresholds: { risk: 'at-least' } },
          { matrix, settlement: { mode: 'no-ask' } },
        ],
      };
      const parsed = parseVariants(document);
      if (!parsed.ok) throw new Error(parsed.problems.join('; '));
      await area.write('variants.json', document);
      const output = await area.dir('derived');
      expect(
        (
          await replay({
            directory: run,
            output,
            variants: join(area.path, 'variants.json'),
          })
        ).code,
      ).toBe(0);
      const outcomes = [];
      const runIds = [];
      for (const selected of parsed.variants) {
        const directory = join(output, selected.variantId);
        outcomes.push((await cellRecordOf(directory, id)).outcome);
        const index = await readJson(join(directory, 'index.json'));
        const report = await readJson(join(directory, 'report.json'));
        const runId = textAt(index, 'runId');
        expect(textAt(report, 'run.runId')).toBe(runId);
        runIds.push(runId);
      }
      expect(new Set(runIds).size).toBe(parsed.variants.length);
      expect(outcomes).toMatchObject([
        {
          risk: 4,
          authorization: 8,
          requiredAuthorization: 8,
          verdict: 'review-allow',
        },
        {
          risk: 4,
          authorization: 8,
          requiredAuthorization: 9,
          verdict: 'review-escalate',
        },
        {
          risk: 3,
          authorization: 8,
          requiredAuthorization: 8,
          verdict: 'review-allow',
        },
        {
          risk: 3,
          authorization: 8,
          requiredAuthorization: 9,
          verdict: 'review-escalate',
        },
        {
          risk: 4,
          authorization: 8,
          requiredAuthorization: 9,
          verdict: 'review-escalate',
        },
      ]);
    });
  });
  it('keeps an unreadable stored answer as failure under a candidate', async () => {
    await withArea(async (area) => {
      const first = CASES[0],
        second = CASES[1];
      if (first === undefined || second === undefined)
        throw new Error('case missing');
      const run = await chatRun(await area.dir('source'), [
        { cellId: chatCellOf(first), text: 'not a score answer' },
        { cellId: chatCellOf(second), text: chatText(3, 8) },
      ]);
      const original = await cellRecordOf(run, chatCellOf(first));
      expect(original.outcome?.status).toBe('review-failure');
      await area.write('variants.json', {
        variantsVersion: REPLAY_VARIANTS_VERSION,
        variants: [{ matrix }],
      });
      const output = await area.dir('derived');
      expect(
        (
          await replay({
            directory: run,
            output,
            variants: join(area.path, 'variants.json'),
          })
        ).code,
      ).toBe(0);
      const derived = await cellRecordOf(
        join(output, variant.variantId),
        chatCellOf(first),
      );
      expect(derived.outcome).toEqual(original.outcome);
      expect(derived.attempts).toEqual(original.attempts);
      expect(derived.usage).toEqual(original.usage);
    });
  });
});
