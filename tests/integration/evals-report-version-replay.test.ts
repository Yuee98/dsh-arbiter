import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseVariants } from '../../evals/src/replay/variants.js';
import { REPLAY_VARIANTS_VERSION } from '../../evals/src/replay/types.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import { reportRun } from '../../evals/src/report/command.js';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import {
  decisionAnswer,
  fixtureCell,
  fixtureOf,
} from '../evals/helpers/run.js';

describe(
  'comparison of verified offline policy derivations',
  { timeout: 60_000 },
  () => {
    it('retains the shared response and discloses actual matrix/N0 conditions without counting another model measurement', async () => {
      await withWorkflowArea(async (area) => {
        const fixture = fixtureOf(
          Object.fromEntries(
            cellGrid(area.plan).cells.map((cell) => [
              cell.cellId,
              fixtureCell({
                decision: [decisionAnswer({ '1': 0.5, '2': 0.5 }, { '7': 1 })],
              }),
            ]),
          ),
        );
        const baseline = await savedRun(area, 'baseline', area.plan, fixture);
        const refs = await syntheticReferences(area, 'refs', area.plan);
        const document = {
          variantsVersion: REPLAY_VARIANTS_VERSION,
          variants: [
            {
              thresholds: { risk: 'at-least', authorization: 'at-least' },
              matrix: {
                id: 'synthetic-nine',
                requiredAuthorization: [2, 2, 9, 9, 9, 9, 10, 10, 10, 10],
              },
            },
          ],
        };
        const parsed = parseVariants(document);
        if (!parsed.ok || parsed.variants[0] === undefined)
          throw new Error('variant missing');
        const path = join(area.directory, 'variants.json');
        await writeFile(path, JSON.stringify(document));
        const output = join(area.directory, 'derived');
        expect(
          await area.cli([
            'replay',
            baseline,
            '--variants',
            path,
            '--out',
            output,
            '--references',
            refs[0] ?? '',
          ]),
        ).toBe(0);
        const current = join(output, parsed.variants[0].variantId);
        const result = await compared(area, baseline, current, refs);
        expect(result.section.pairedConditions).toBe(2);
        expect(result.section.current.conditions).toMatchObject({
          origin: 'verified-offline-replay',
          thresholds: [
            { field: 'risk', mode: 'at-least' },
            { field: 'authorization', mode: 'at-least' },
          ],
          requiredAuthorization: [2, 2, 9, 9, 9, 9, 10, 10, 10, 10],
        });
        expect(
          result.section.rows.every((row) =>
            row.conditionChanges.includes('policy-or-replay'),
          ),
        ).toBe(true);
        const lineage: unknown = JSON.parse(
          await readFile(join(current, 'lineage.json'), 'utf8'),
        );
        expect(lineage).toMatchObject({ totals: { cells: 2, reDerived: 2 } });
        for (const cell of result.section.baseline.cells) {
          const derived = result.section.current.cells.find(
            (item) =>
              item.source.kind === 'workflow' &&
              cell.source.kind === 'workflow' &&
              item.source.pointId === cell.source.pointId,
          );
          expect(derived?.model).toEqual(cell.model);
          expect(derived?.inputHash).toBe(cell.inputHash);
        }
        const other = await savedRun(area, 'other-baseline');
        const separate = await compared(area, other, current, refs);
        for (const target of [
          join(current, 'lineage.json'),
          join(current, 'references/reference-1.json'),
          join(baseline, 'index.json'),
        ]) {
          const before = await readFile(target);
          expect(
            await reportRun(
              { root: area.root, out: () => {}, err: () => {} },
              {
                ...separate.command,
                output: target.slice(0, -5),
                force: true,
              },
            ),
          ).toBe(1);
          expect(await readFile(target)).toEqual(before);
        }
      });
    });
  },
);
