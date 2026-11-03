/** Real offline artifacts for report tests; all provenance/references here are synthetic. */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reportRun } from '../../../evals/src/report/command.js';
import { publishReport } from '../../../evals/src/report/publication.js';
import {
  buildReport,
  defaultSettings,
} from '../../../evals/src/metrics/index.js';
import { observeRun } from '../../../evals/src/metrics/observe.js';
import { cellGrid } from '../../../evals/src/run/grid.js';
import type { RunPlan } from '../../../evals/src/run/types.js';
import { collectionOf } from '../fixtures/workflow.js';
import { fixtureCell, fixtureOf } from './run.js';
import { workflowArea } from './workflow-run.js';
import {
  dualProtocolPlan,
  frozenWorkflowReferences,
} from './report-workflow.js';

export const ATTACK_TEXT =
  '</script><script>globalThis.reportAttack = true</script><img src="https://example.invalid/report-leak" onerror="globalThis.reportAttack=true"><svg onload="globalThis.reportAttack=true"></svg>';
export const BODY_CANARY = 'synthetic_body_secret_132';

export async function reportBrowserFixture(
  kind: 'partial' | 'unsafe' | 'large' = 'partial',
) {
  const area = await workflowArea();
  try {
    const events =
      kind === 'unsafe'
        ? area.source.events.map((event) =>
            event.kind === 'result' && event.callId === 'scan'
              ? {
                  ...event,
                  body: { state: 'present' as const, content: ATTACK_TEXT },
                }
              : event,
          )
        : area.source.events;
    if (kind === 'unsafe')
      await writeFile(
        area.sourcePath,
        JSON.stringify(collectionOf({ ...area.source, events })),
      );
    const second = {
      ...area.source,
      events,
      rootId: 'second-root',
      lineageId: 'second-lineage',
      provenance: {
        ...area.source.provenance,
        source: 'reconstructed' as const,
        origin:
          'Synthetic test of reconstructed provenance, not evaluation evidence',
      },
      points: area.source.points.map((point) => ({
        ...point,
        pointId: `second-${point.pointId}`,
        primaryViewId: `second-${point.primaryViewId}`,
        ...(point.predecessorPointId === undefined
          ? {}
          : { predecessorPointId: `second-${point.predecessorPointId}` }),
      })),
    };
    await mkdir(join(area.datasetPath, 'dev/f02'), { recursive: true });
    await writeFile(
      join(area.datasetPath, 'dev/f02/workflows.json'),
      JSON.stringify(collectionOf(second)),
    );
    const first = area.plan.workflow?.points[0];
    const next = second.points[1];
    if (first === undefined || next === undefined)
      throw new Error('fixture points missing');
    const base = kind === 'partial' ? dualProtocolPlan(area.plan) : area.plan;
    if (base.workflow === undefined)
      throw new Error('fixture workflow missing');
    const plan: RunPlan = {
      ...base,
      targets: area.plan.targets,
      repeats: kind === 'large' ? 100 : base.repeats,
      workflow: {
        ...base.workflow,
        input:
          kind === 'partial'
            ? base.workflow.input
            : { customRules: '', projectRules: { kind: 'disabled' } },
        points: [
          first,
          {
            group: 'f02',
            rootId: second.rootId,
            pointId: next.pointId,
            viewId: next.primaryViewId,
          },
        ],
      },
      bounds: { ...base.bounds, maxAttempts: kind === 'partial' ? 1 : 400 },
      resource: {
        runDirectory: area.runDirectory,
        maxAttempts: kind === 'partial' ? 1 : 400,
        maxEstimatedInputTokens: 4_000_000,
      },
    };
    await area.write(plan);
    if (kind !== 'partial') {
      const cells = cellGrid(plan).cells.filter((cell) => cell.supported);
      await writeFile(
        area.fixturePath,
        JSON.stringify(
          fixtureOf(
            Object.fromEntries(
              cells.map((cell, index) => {
                const body =
                  kind === 'large'
                    ? `PUBLIC MATERIAL\n${'readable stored text\n'.repeat(1700)}END_${cell.cellId}__END`
                    : index === 0
                      ? `TOOL AND MODEL TEXT ${ATTACK_TEXT}\n${JSON.stringify({ status: ATTACK_TEXT, source: ATTACK_TEXT })}`
                      : `token=${BODY_CANARY}`;
                return [
                  cell.cellId,
                  fixtureCell({ decision: [{ status: 200, body }] }),
                ];
              }),
            ),
          ),
        ),
      );
    }
    const references =
      kind === 'partial'
        ? await frozenWorkflowReferences(area.directory, plan)
        : [];
    const runExit = await area.cli(['run', area.planPath]);
    if (runExit !== (kind === 'partial' ? 1 : 0))
      throw new Error(
        `unexpected synthetic run exit ${String(runExit)}: ${area.log.join('\n')}`,
      );
    const prefix = join(area.directory, 'report space', 'full report');
    const reportExit = await reportRun(
      {
        root: area.root,
        out: (line) => area.log.push(line),
        err: (line) => area.log.push(line),
      },
      {
        directory: area.runDirectory,
        dataset: null,
        references,
        output: prefix,
        mode: 'ask',
        channel: 'available',
        force: false,
      },
    );
    if (reportExit !== 0) throw new Error(area.log.join('\n'));
    const settings = { ...defaultSettings(area.root), references };
    const observed = await observeRun({
      directory: area.runDirectory,
      root: area.root,
      dataset: settings.dataset,
      references,
    });
    if (!observed.ok) throw new Error(observed.problems.join('\n'));
    const report = publishReport({
      report: buildReport({ observation: observed.observation, settings }),
      observation: observed.observation,
      directory: area.runDirectory,
      settings,
    });
    return {
      ...area,
      plan,
      references,
      prefix,
      report,
      htmlPath: `${prefix}.html`,
      async text(format: 'html' | 'json' | 'md') {
        return readFile(`${prefix}.${format}`, 'utf8');
      },
    };
  } catch (error) {
    await area.remove();
    throw error;
  }
}
