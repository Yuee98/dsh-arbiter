import { cp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readReferenceSnapshot } from '../../evals/src/metrics/reference-snapshot.js';
import { parseVariants } from '../../evals/src/replay/variants.js';
import { REPLAY_VARIANTS_VERSION } from '../../evals/src/replay/types.js';
import { cellGrid } from '../../evals/src/run/grid.js';
import type { RunPlan } from '../../evals/src/run/types.js';
import { collectionOf } from '../evals/fixtures/workflow.js';
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
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';

async function revise(
  paths: readonly string[],
  changes: {
    readonly scoringEligible?: boolean;
    readonly behaviour?: 'allow' | 'deny' | null;
  },
) {
  for (const path of paths) {
    const snapshot = await readReferenceSnapshot(path);
    await writeFile(
      path,
      JSON.stringify({
        ...snapshot,
        entries: snapshot.entries.map((entry) => {
          if (entry.reference === null)
            throw new Error('synthetic reference missing');
          const scoringEligible =
            changes.scoringEligible ?? entry.scoringEligible;
          return {
            ...entry,
            scoringEligible,
            reference: {
              ...entry.reference,
              scoringEligible,
              target: {
                ...entry.reference.target,
                ...(changes.behaviour === undefined
                  ? {}
                  : { behaviourReference: changes.behaviour }),
              },
            },
          };
        }),
      }),
    );
  }
}
const candidate: RunPlan['candidate'] = {
  candidateId: 'synthetic-compact',
  prompt: 'no-probe',
  structure: 'compact',
  history: 'current-turn',
  scale: 'complete',
};

describe(
  'independent comparison metric qualifications',
  { timeout: 60_000 },
  () => {
    it.each(['baseline', 'current'] as const)(
      'retains behaviour when only the %s common reference lacks scoring eligibility',
      async (side) => {
        await withWorkflowArea(async (area) => {
          const alternative = { ...area.plan, candidate };
          const baseline = await savedRun(area, 'baseline');
          const current = await savedRun(area, 'current', alternative);
          const oldRefs = await syntheticReferences(area, 'old', area.plan);
          const newRefs = await syntheticReferences(area, 'new', alternative);
          await revise(side === 'baseline' ? oldRefs : newRefs, {
            scoringEligible: false,
          });
          const result = await compared(
            area,
            baseline,
            current,
            [...oldRefs, ...newRefs],
            oldRefs,
          );
          expect(result.section.behaviour).toMatchObject({
            paired: 2,
            unchanged: 2,
          });
          expect(result.section.scoring).toMatchObject({
            paired: 0,
            baselineRate: null,
            currentRate: null,
          });
        });
      },
    );
    it('retains scoring when common behaviour conflicts on only one side', async () => {
      await withWorkflowArea(async (area) => {
        const alternative = { ...area.plan, candidate };
        const baseline = await savedRun(area, 'baseline');
        const current = await savedRun(area, 'current', alternative);
        const oldRefs = await syntheticReferences(area, 'old', area.plan);
        const newRefs = await syntheticReferences(area, 'new', alternative);
        await revise(oldRefs, { behaviour: 'deny' });
        const result = await compared(
          area,
          baseline,
          current,
          [...oldRefs, ...newRefs],
          oldRefs,
        );
        expect(result.section.behaviour).toMatchObject({
          paired: 0,
          baselineRate: null,
          currentRate: null,
        });
        expect(result.section.scoring).toMatchObject({
          paired: 2,
          unchanged: 2,
        });
      });
    });
    it('pairs changed omitted source material only when both newly saved responses have the same qualified effective view', async () => {
      await withWorkflowArea(async (area) => {
        const plan = {
          ...area.plan,
          context: { ...area.plan.context, targetInputTokens: 1 },
        };
        const baseline = await savedRun(area, 'baseline', plan);
        const oldRefs = await syntheticReferences(area, 'old', plan);
        const dataset = join(area.directory, 'changed-source');
        await cp(area.datasetPath, dataset, { recursive: true });
        await writeFile(
          join(dataset, 'dev/f01/workflows.json'),
          JSON.stringify(
            collectionOf({
              ...area.source,
              events: area.source.events.map((event) =>
                event.kind === 'result' && event.eventId === 'scan-result'
                  ? {
                      ...event,
                      body: {
                        state: 'present' as const,
                        content: 'different unselected tool text',
                      },
                    }
                  : event,
              ),
            }),
          ),
        );
        const alternative = { ...plan, datasetPath: dataset };
        const current = await savedRun(area, 'current', alternative);
        const newRefs = await syntheticReferences(area, 'new', alternative);
        const result = await compared(
          area,
          baseline,
          current,
          newRefs,
          oldRefs,
        );
        expect(result.section.pairedConditions).toBe(2);
        expect(result.section.baseline.cells[0]?.inputHash).not.toBe(
          result.section.current.cells[0]?.inputHash,
        );
        expect(
          result.section.rows.every((row) =>
            row.conditionChanges.includes('source-input'),
          ),
        ).toBe(true);
        expect(
          result.section.rows.every(
            (row) => !row.reasons.includes('input-changed'),
          ),
        ).toBe(true);
      });
    });
    it('shows an actual allow-to-escalate replay migration when both outcomes remain incorrect', async () => {
      await withWorkflowArea(async (area) => {
        const fixture = fixtureOf(
          Object.fromEntries(
            cellGrid(area.plan).cells.map((cell) => [
              cell.cellId,
              fixtureCell({
                decision: [decisionAnswer({ '2': 1 }, { '7': 1 })],
              }),
            ]),
          ),
        );
        const baseline = await savedRun(area, 'baseline', area.plan, fixture);
        const refs = await syntheticReferences(area, 'refs', area.plan, 'deny');
        const document = {
          variantsVersion: REPLAY_VARIANTS_VERSION,
          variants: [
            {
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
        const path = join(area.directory, 'variants.json'),
          output = join(area.directory, 'derived');
        await writeFile(path, JSON.stringify(document));
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
        const result = await compared(
          area,
          baseline,
          join(output, parsed.variants[0].variantId),
          refs,
        );
        expect(result.section.behaviour).toMatchObject({
          paired: 2,
          baselineMatched: 0,
          currentMatched: 0,
          unchanged: 2,
        });
        for (const row of result.section.rows)
          expect(row).toMatchObject({
            behaviourChange: { outcome: 'unchanged' },
            behaviourMigration: {
              changed: true,
              baseline: { behaviour: 'allow', classification: 'false-allow' },
              current: {
                behaviour: 'escalate',
                classification: 'escalate-not-deny',
              },
            },
          });
        for (const format of result.formats) {
          expect(format).toContain('false-allow');
          expect(format).toContain('escalate-not-deny');
        }
        const markdownMigration = result.formats[1]
          ?.split('\n')
          .find(
            (line) =>
              line.includes('false-allow') &&
              line.includes('escalate-not-deny'),
          );
        expect(markdownMigration).toContain('allow');
        expect(markdownMigration).toContain('escalate');
        const htmlRows = result.formats[2]?.match(/<tr>.*?<\/tr>/gu) ?? [];
        expect(
          htmlRows.some(
            (row) =>
              row.includes('false-allow') &&
              row.includes('escalate-not-deny') &&
              row.includes('>allow<') &&
              row.includes('>escalate<'),
          ),
        ).toBe(true);
        expect(await readFile(path, 'utf8')).toContain('synthetic-nine');
      });
    });
  },
);
