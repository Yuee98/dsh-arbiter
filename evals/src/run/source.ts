import { resolve } from 'node:path';
import { DEFAULT_CONFIG, stableHash } from '../../../src/config.js';
import type { ArbiterConfig } from '../../../src/types.js';
import { readGroupedDataset } from '../data/group-read.js';
import type { GroupedDataset, Workflow } from '../data/group-types.js';
import type { Provenance, ReviewCase } from '../data/types.js';
import { executionDigest } from './artifact.js';
import { canonicalJson } from '../data/hash.js';
import { candidateOf } from './candidate.js';
import { caseMaterial, workflowMaterial } from './material.js';
import type { CaseMaterial } from './material.js';
import type { RunPlan, RunProtocol } from './types.js';
import type { WorkflowIdentity } from './workflow-types.js';

export interface WorkflowSource {
  readonly kind: 'workflow';
  readonly directory: string;
  /** Compatibility address, never a legacy ReviewCase identity. */
  readonly caseId: string;
  readonly familyId: string;
  readonly split: ReviewCase['split'];
  readonly provenance: Provenance;
  readonly workflow: WorkflowIdentity;
  readonly dataset: GroupedDataset;
  readonly document: Workflow;
}

export type RunSource = ReviewCase | WorkflowSource;

export function isWorkflowSource(source: RunSource): source is WorkflowSource {
  return 'kind' in source;
}

export function effectiveWorkflowConfig(plan: RunPlan): ArbiterConfig {
  if (plan.workflow === undefined) throw new Error('workflow input is missing');
  return {
    ...DEFAULT_CONFIG,
    context: {
      ...DEFAULT_CONFIG.context,
      ...plan.context,
      targetInputTokens:
        plan.context.targetInputTokens ??
        Math.min(6000, plan.context.maxInputTokens),
      customRules: plan.workflow.input.customRules,
      projectRules: {
        ...DEFAULT_CONFIG.context.projectRules,
        enabled: plan.workflow.input.projectRules.kind === 'provided',
      },
    },
  };
}

export async function sourceMaterial(
  source: RunSource,
  protocol: RunProtocol,
  plan: RunPlan,
): Promise<CaseMaterial> {
  const pkg = candidateOf(plan).pkg;
  if (!isWorkflowSource(source))
    return caseMaterial(source, protocol, { ...plan.context, pkg });
  if (plan.workflow === undefined)
    throw new Error('workflow source in legacy plan');
  const config = effectiveWorkflowConfig(plan);
  const rules = plan.workflow.input.projectRules;
  return workflowMaterial(
    source.dataset,
    source.workflow.rootId,
    source.workflow.pointId,
    protocol,
    {
      config,
      configRevision: stableHash(canonicalJson(config)),
      projectRules: rules.kind === 'provided' ? rules.text : null,
      pkg,
    },
  );
}

/** Only the explicitly selected groups/split are opened, never reference files. */
export async function loadWorkflowSources(
  root: string,
  plan: RunPlan,
): Promise<{
  readonly cases: readonly RunSource[];
  readonly digest: string;
  readonly datasetId: string;
  readonly labelProblems: readonly string[];
}> {
  if (plan.workflow === undefined || plan.split === 'all')
    throw new Error('workflow selection needs an explicit split');
  const groups = new Map<string, GroupedDataset>();
  const cases: WorkflowSource[] = [];
  const documents = new Map<string, unknown>();
  for (const selected of plan.workflow.points) {
    let dataset = groups.get(selected.group);
    if (dataset === undefined) {
      dataset = await readGroupedDataset(resolve(root, plan.datasetPath), {
        split: plan.split,
        group: selected.group,
        contentSet: 'workflows-v1',
        references: false,
      });
      if (dataset.problems.length > 0)
        throw new Error(
          dataset.problems.map((p) => `${p.path}: ${p.message}`).join('; '),
        );
      groups.set(selected.group, dataset);
    }
    const workflow = dataset.groups
      .flatMap((g) => g.workflows)
      .find((entry) => entry.document.rootId === selected.rootId)?.document;
    const point = workflow?.points.find((p) => p.pointId === selected.pointId);
    if (workflow === undefined || point?.primaryViewId !== selected.viewId)
      throw new Error(
        `unknown workflow primary view ${selected.group}/${selected.rootId}/${selected.pointId}/${selected.viewId}`,
      );
    const lineageId = workflow.lineageId ?? workflow.rootId;
    if (selected.lineageId !== undefined && selected.lineageId !== lineageId)
      throw new Error(`workflow lineage does not match ${selected.rootId}`);
    cases.push({
      kind: 'workflow',
      directory: resolve(root, plan.datasetPath),
      caseId: selected.viewId,
      familyId: lineageId,
      split: plan.split,
      provenance: workflow.provenance,
      workflow: { ...selected, lineageId },
      dataset,
      document: workflow,
    });
    documents.set(`${selected.group}/${selected.rootId}`, workflow);
  }
  return {
    cases,
    // Grouped sources have no manifest: datasetId is the plan's naming, not a source declaration.
    datasetId: plan.datasetId,
    digest: executionDigest({
      manifest: { split: plan.split, contentSet: 'workflows-v1' },
      cases: [...documents.values()],
    }),
    labelProblems: [],
  };
}

export function resolveWorkflowPlan(
  plan: RunPlan,
  sources: readonly RunSource[],
): RunPlan {
  if (plan.workflow === undefined) return plan;
  const byView = new Map(
    sources.filter(isWorkflowSource).map((s) => [s.caseId, s.workflow]),
  );
  return {
    ...plan,
    workflow: {
      ...plan.workflow,
      points: plan.workflow.points.map((p) => byView.get(p.viewId) ?? p),
    },
  };
}

export function workflowSourceDigest(
  plan: RunPlan,
  sources: readonly RunSource[],
): string {
  const documents = new Map<string, unknown>();
  for (const source of sources) {
    if (!isWorkflowSource(source))
      throw new Error('legacy source in workflow run');
    documents.set(
      `${source.workflow.group}/${source.workflow.rootId}`,
      source.document,
    );
  }
  return executionDigest({
    manifest: { split: plan.split, contentSet: 'workflows-v1' },
    cases: [...documents.values()],
  });
}
