/** Synthetic frozen references over the real workflow runner; no human/model decisions. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { workflowReferences } from '../../../evals/src/annotation/workflow-service.js';
import { DEFAULT_ANNOTATION_CONTEXT } from '../../../evals/src/annotation/workflow-view.js';
import type { ReferenceSnapshot } from '../../../evals/src/metrics/reference-snapshot.js';
import type { WorkflowLabel } from '../../../evals/src/data/group-types.js';
import type { RunPlan } from '../../../evals/src/run/types.js';
import type { ReferenceWord } from '../../../evals/src/metrics/types.js';
import { approvedTarget } from '../fixtures/documents.js';
import { chatTarget } from './run.js';
import {
  reportForRun,
  defaultSettings,
} from '../../../evals/src/metrics/index.js';

export async function frozenWorkflowReferences(
  directory: string,
  plan: RunPlan,
  behaviour: ReferenceWord = 'deny',
): Promise<readonly string[]> {
  const paths: string[] = [];
  const groups = [
    ...new Set(plan.workflow?.points.map((point) => point.group)),
  ];
  for (const group of groups)
    for (const protocol of plan.protocols) {
      const snapshot = await workflowReferences({
        root: directory,
        dataset: plan.datasetPath,
        split: 'dev',
        group,
        context: {
          ...DEFAULT_ANNOTATION_CONTEXT,
          protocol,
          targetInputTokens: plan.context.targetInputTokens ?? 6000,
          maxInputTokens: plan.context.maxInputTokens,
          customRules: plan.workflow?.input.customRules ?? '',
          projectRules:
            plan.workflow?.input.projectRules.kind === 'provided'
              ? plan.workflow.input.projectRules.text
              : null,
        },
      });
      const entries = snapshot.entries.map(
        (entry): ReferenceSnapshot['entries'][number] => {
          if (entry.binding === null)
            throw new Error('synthetic binding unavailable');
          const scored =
            behaviour !== 'insufficient-material' &&
            behaviour !== 'review-failure';
          const label: WorkflowLabel = {
            rootId: entry.rootId,
            pointId: entry.pointId,
            viewId: entry.viewId,
            referenceId: `synthetic-${protocol}-${entry.pointId}`,
            source: 'human',
            humanConfirmed: true,
            scoringEligible: scored,
            versions: entry.binding.versions,
            batchId: 'synthetic',
            supportingOpinionIds: [],
            target: approvedTarget({
              allowed: scored
                ? { risk: [1], authorization: [9] }
                : { risk: null, authorization: null },
              behaviourReference: behaviour,
            }),
            annotation: { binding: entry.binding, humanState: 'confirmed' },
          };
          return {
            ...entry,
            source: 'human',
            humanConfirmed: true,
            scoringEligible: scored,
            reference: label,
            reasons: [],
          };
        },
      );
      const path = join(directory, `references-${group}-${protocol}.json`);
      await writeFile(path, JSON.stringify({ ...snapshot, entries }));
      paths.push(path);
    }
  return paths;
}
export async function workflowReport(
  directory: string,
  run: string,
  references: readonly string[],
) {
  const result = await reportForRun({
    directory: run,
    settings: { ...defaultSettings(directory), references },
  });
  if (!result.ok) throw new Error(result.problems.join('; '));
  return result.report;
}
export function dualProtocolPlan(plan: RunPlan): RunPlan {
  if (plan.workflow === undefined) throw new Error('workflow plan required');
  return {
    ...plan,
    workflow: {
      ...plan.workflow,
      input: {
        ...plan.workflow.input,
        projectRules: { kind: 'provided', text: 'Synthetic project guidance.' },
      },
    },
    repeats: 2,
    protocols: ['chat', 'decision'],
    targets: plan.targets.map((target) => ({
      ...target,
      chat: chatTarget().chat,
    })),
  };
}
