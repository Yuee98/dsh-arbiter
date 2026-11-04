import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';
import {
  compared,
  savedRun,
  syntheticReferences,
} from '../evals/helpers/version-comparison.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import {
  decisionAnswer,
  fixtureCell,
  fixtureOf,
} from '../evals/helpers/run.js';

async function inventory(
  path: string,
): Promise<readonly (readonly [string, string])[]> {
  const entries = await readdir(path, { withFileTypes: true });
  const result: (readonly [string, string])[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) result.push(...(await inventory(target)));
    else result.push([target, await readFile(target, 'utf8')]);
  }
  return result;
}
describe('saved-run version comparison', { timeout: 60_000 }, () => {
  it('counts improvements and regressions only on the same qualified members', async () => {
    await withWorkflowArea(async (area) => {
      const fixture = fixtureOf(
        Object.fromEntries(
          cellGrid(area.plan).cells.map((cell) => [
            cell.cellId,
            fixtureCell({ decision: [decisionAnswer({ '9': 1 }, { '0': 1 })] }),
          ]),
        ),
      );
      const baseline = await savedRun(area, 'baseline', area.plan, fixture);
      const current = await savedRun(area, 'current');
      const refs = await syntheticReferences(area, 'refs', area.plan);
      const forward = await compared(area, baseline, current, refs);
      expect(forward.section.behaviour).toMatchObject({
        paired: 2,
        baselineMatched: 0,
        currentMatched: 2,
        improved: 2,
        regressed: 0,
      });
      expect(forward.section.scoring).toMatchObject({
        paired: 2,
        improved: 2,
        regressed: 0,
      });
      expect(
        forward.section.rows.every(
          (row) => row.behaviourChange?.outcome === 'improved',
        ),
      ).toBe(true);
      const backward = await compared(area, current, baseline, refs);
      expect(backward.section.behaviour).toMatchObject({
        paired: 2,
        improved: 0,
        regressed: 2,
      });
      expect(backward.section.scoring).toMatchObject({
        paired: 2,
        improved: 0,
        regressed: 2,
      });
    });
  });
  it('pairs separately executed matching inputs offline and preserves both runs in all formats', async () => {
    await withWorkflowArea(async (area) => {
      const baseline = await savedRun(area, 'baseline');
      const current = await savedRun(area, 'current');
      const references = await syntheticReferences(area, 'common', area.plan);
      const before = await Promise.all([
        inventory(baseline),
        inventory(current),
      ]);
      const network = vi
        .spyOn(globalThis, 'fetch')
        .mockRejectedValue(new Error('offline comparison'));
      try {
        const result = await compared(area, baseline, current, references);
        expect({ exit: result.exit, errors: result.errors }).toEqual({
          exit: 0,
          errors: [],
        });
        expect(result.section).toMatchObject({
          unionConditions: 2,
          pairedConditions: 2,
          pairedPoints: 2,
          behaviour: {
            paired: 2,
            baselineMatched: 2,
            currentMatched: 2,
            unchanged: 2,
          },
          scoring: { paired: 2, unchanged: 2 },
          baseline: {
            cellsPlanned: 2,
            historicalReferences: 'not-established-by-saved-run',
          },
        });
        for (const text of result.formats) {
          expect(text).toContain('baseline');
          expect(text).toContain('current');
        }
        expect(JSON.parse(result.formats[0] ?? '') as unknown).toMatchObject({
          versionComparison: result.section,
        });
        expect(result.formats[1]).toContain('跨版本比较');
        expect(result.formats[2]).toContain('id="version-comparison"');
        expect(
          (await compared(area, baseline, current, references)).formats,
        ).toEqual(result.formats);
        expect(
          await Promise.all([inventory(baseline), inventory(current)]),
        ).toEqual(before);
        expect(network).not.toHaveBeenCalled();
      } finally {
        network.mockRestore();
      }
    });
  });
  it('retains original reference results while reclassifying both responses under the new reference', async () => {
    await withWorkflowArea(async (area) => {
      const baseline = await savedRun(area, 'baseline');
      const current = await savedRun(area, 'current');
      const oldReferences = await syntheticReferences(
        area,
        'old',
        area.plan,
        'deny',
      );
      const references = await syntheticReferences(
        area,
        'new',
        area.plan,
        'allow',
      );
      const result = await compared(
        area,
        baseline,
        current,
        references,
        oldReferences,
      );
      expect(result.section.baseline).toMatchObject({
        original: { matched: 0, compared: 2 },
        common: { matched: 2, compared: 2 },
      });
      expect(result.section.behaviour).toMatchObject({
        paired: 2,
        improved: 0,
        regressed: 0,
        unchanged: 2,
      });
      expect(
        result.section.baseline.cells.every(
          (cell) =>
            cell.original.classification === 'false-allow' &&
            cell.common.classification === 'matched',
        ),
      ).toBe(true);
      expect(await readFile(oldReferences[0] ?? '', 'utf8')).toContain('deny');
    });
  });
});
