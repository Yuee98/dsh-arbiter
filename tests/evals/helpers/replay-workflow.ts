/** Synthetic test references from the pure binding API, never annotation services. */
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../../../src/config.js';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { annotationBindingOf } from '../../../evals/src/annotation/workflow-binding.js';
import { legacyMetadata } from '../../../evals/src/data/legacy-metadata.js';
import { candidateOf } from '../../../evals/src/run/candidate.js';
import {
  loadWorkflowSources,
  sourceMaterial,
  isWorkflowSource,
} from '../../../evals/src/run/source.js';
import type { RunPlan } from '../../../evals/src/run/types.js';
import type { ReferenceSnapshot } from '../../../evals/src/metrics/reference-snapshot.js';
import { approvedTarget } from '../fixtures/documents.js';

export async function replayReferences(
  root: string,
  directory: string,
  plan: RunPlan,
): Promise<readonly string[]> {
  if (plan.workflow === undefined) throw new Error('workflow plan missing');
  const loaded = await loadWorkflowSources(root, plan);
  const paths: string[] = [];
  const versions = (await legacyMetadata()).versions;
  for (const protocol of plan.protocols) {
    const entries: ReferenceSnapshot['entries'][number][] = [];
    for (const source of loaded.cases.filter(isWorkflowSource)) {
      const material = await sourceMaterial(source, protocol, plan);
      const binding = annotationBindingOf({
        material,
        protocol,
        pkg: candidateOf(plan).pkg,
        versions: {
          contract: REVIEW_CONTRACT_VERSION,
          rubric: versions.rubric,
          policy: DEFAULT_CONFIG.policy.version,
        },
      });
      entries.push({
        rootId: source.workflow.rootId,
        pointId: source.workflow.pointId,
        viewId: source.workflow.viewId,
        source: 'human',
        humanConfirmed: true,
        scoringEligible: true,
        consensus: null,
        binding,
        request: material.request,
        reasons: [],
        staleReferenceIds: [],
        error: null,
        reference: {
          rootId: source.workflow.rootId,
          pointId: source.workflow.pointId,
          viewId: source.workflow.viewId,
          referenceId: `synthetic-${protocol}-${source.workflow.pointId}`,
          source: 'human',
          humanConfirmed: true,
          scoringEligible: true,
          versions: binding.versions,
          batchId: 'synthetic-replay',
          supportingOpinionIds: [],
          target: approvedTarget({
            allowed: { risk: [3], authorization: [8] },
            behaviourReference: 'deny',
          }),
          annotation: { binding, humanState: 'confirmed' },
        },
      });
    }
    const first = plan.workflow.points[0];
    if (first === undefined || plan.split === 'all')
      throw new Error('selection missing');
    const snapshot: ReferenceSnapshot = {
      snapshotVersion: 'workflow-references-v1',
      sourceCommit: null,
      sourceDirty: null,
      createdAt: '2026-11-02T00:00:00.000Z',
      scope: {
        split: plan.split,
        group: first.group,
      },
      context: {
        protocol,
        targetInputTokens: plan.context.targetInputTokens ?? 6000,
        maxInputTokens: plan.context.maxInputTokens,
        customRules: plan.workflow.input.customRules,
        projectRules:
          plan.workflow.input.projectRules.kind === 'provided'
            ? plan.workflow.input.projectRules.text
            : null,
      },
      entries,
    };
    const path = join(directory, `synthetic-reference-${protocol}.json`);
    await writeFile(path, JSON.stringify(snapshot));
    paths.push(path);
  }
  return paths;
}
