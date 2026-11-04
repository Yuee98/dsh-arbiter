/** Offline adapter for the runner's public, identity-aware workflow artifact. */
import { resolve } from 'node:path';
import { stableHash } from '../../../src/config.js';
import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { USAGE_MAPPING_VERSION } from '../../../src/reviewer/usage.js';
import { canonicalJson } from '../data/hash.js';
import { legacyMetadata } from '../data/legacy-metadata.js';
import { annotationBindingOf } from '../annotation/workflow-binding.js';
import { candidateOf } from '../run/candidate.js';
import {
  effectiveWorkflowConfig,
  isWorkflowSource,
  loadWorkflowSources,
  sourceMaterial,
} from '../run/source.js';
import type { WorkflowSource } from '../run/source.js';
import {
  RUNNER_IMPLEMENTATION_VERSION,
  RUN_ARTIFACT_VERSION,
} from '../run/types.js';
import type { RunArtifact } from '../run/artifact.js';
import type { MetricSource } from './source.js';
import type { MetricReference } from './references.js';
import type { CellFacts } from './cell.js';
import type { ReferenceSnapshot } from './reference-snapshot.js';
import { frozenReferenceFor } from './reference-snapshot.js';
import { workflowMaterialProblems } from './workflow-proof.js';
import { verifiedReplayOrigin } from '../replay/origin.js';
import { REPLAY_IMPLEMENTATION_VERSION } from '../replay/types.js';
import type { WorkflowMetricSource } from './workflow-metrics-types.js';

export interface WorkflowCellObservation {
  readonly source: Extract<MetricSource, { kind: 'workflow' }>;
  readonly caseFacts: CellFacts['caseFacts'];
  readonly reference: MetricReference;
}
export interface WorkflowObservation {
  readonly cells: ReadonlyMap<string, WorkflowCellObservation>;
  readonly sources: readonly WorkflowMetricSource[];
  readonly problems: readonly string[];
}
function versionProblems(
  artifact: RunArtifact,
  verifiedReplay: boolean,
): readonly string[] {
  const expected = {
    contract: REVIEW_CONTRACT_VERSION,
    prompt: REVIEW_PROMPT_VERSION,
    usageMapping: USAGE_MAPPING_VERSION,
    implementation: verifiedReplay
      ? REPLAY_IMPLEMENTATION_VERSION
      : RUNNER_IMPLEMENTATION_VERSION,
    artifact: RUN_ARTIFACT_VERSION,
    plan: artifact.plan.planVersion,
  };
  const versions = [
    artifact.index.versions,
    ...artifact.records.map((record) => record.versions),
  ];
  return Object.entries(expected).flatMap(([key, value]) =>
    versions.some(
      (version) =>
        Object.entries(version).find(([name]) => name === key)?.[1] !== value,
    )
      ? [`workflow-${key}-version-drift`]
      : [],
  );
}
export async function observeWorkflow(parts: {
  readonly directory: string;
  readonly artifact: RunArtifact;
  readonly root: string;
  readonly datasetPath: string | null;
  readonly snapshots: readonly ReferenceSnapshot[];
}): Promise<WorkflowObservation> {
  const { artifact } = parts,
    plan = artifact.plan;
  const config = effectiveWorkflowConfig(plan),
    recorded = artifact.index.workflowExecution;
  const replay =
    artifact.index.versions.implementation === REPLAY_IMPLEMENTATION_VERSION &&
    (await verifiedReplayOrigin({
      directory: parts.directory,
      root: parts.root,
      artifact,
    }));
  const problems = [...versionProblems(artifact, replay)];
  if (
    recorded === undefined ||
    canonicalJson(recorded.config) !== canonicalJson(config) ||
    recorded.configRevision !== stableHash(canonicalJson(config))
  )
    problems.push('workflow-config-unverified');
  const sources: WorkflowSource[] = [];
  if (parts.datasetPath === null) problems.push('workflow-source-not-supplied');
  else {
    try {
      const loaded = await loadWorkflowSources(parts.root, {
        ...plan,
        datasetPath: parts.datasetPath,
      });
      sources.push(...loaded.cases.filter(isWorkflowSource));
      if (loaded.digest !== artifact.index.dataset.digest)
        problems.push('workflow-source-digest-drift');
    } catch (error) {
      problems.push(
        `workflow-source-unreadable: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  const versions = (await legacyMetadata()).versions;
  const pkg = candidateOf(plan).pkg;
  const records = new Map(
    artifact.records.map((record) => [record.cellId, record]),
  );
  const cells = new Map<string, WorkflowCellObservation>();
  const materials = new Map<
    string,
    Awaited<ReturnType<typeof sourceMaterial>>
  >();
  for (const state of artifact.index.cells) {
    const selected = plan.workflow?.points.find(
      (point) => point.viewId === state.caseId,
    );
    if (selected === undefined || selected.lineageId === undefined)
      throw new Error('workflow frozen identity is missing');
    const source = sources.find(
      (entry) => canonicalJson(entry.workflow) === canonicalJson(selected),
    );
    const point = source?.document.points.find(
      (entry) => entry.pointId === selected.pointId,
    );
    const reasons = [...problems];
    if (source === undefined)
      reasons.push('workflow-source-identity-unverified');
    let binding = null;
    if (reasons.length === 0 && source !== undefined) {
      try {
        const key = JSON.stringify([
          selected.group,
          selected.rootId,
          selected.pointId,
          selected.viewId,
          state.protocol,
        ]);
        let material = materials.get(key);
        if (material === undefined) {
          material = await sourceMaterial(source, state.protocol, plan);
          materials.set(key, material);
        }
        const candidateBinding = annotationBindingOf({
          material,
          protocol: state.protocol,
          pkg,
          versions: {
            contract: artifact.index.versions.contract,
            rubric: versions.rubric,
            policy: config.policy.version,
          },
        });
        const materialProblems = workflowMaterialProblems({
          material,
          record: records.get(state.cellId) ?? null,
          protocol: state.protocol,
          credentials: candidateBinding.credentials,
        });
        reasons.push(...materialProblems);
        if (materialProblems.length === 0) binding = candidateBinding;
      } catch (error) {
        reasons.push(
          `workflow-material-unverified: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const reference = frozenReferenceFor({
      snapshots: parts.snapshots,
      ...selected,
      split: plan.split,
      protocol: state.protocol,
      binding,
    });
    cells.set(state.cellId, {
      source: {
        kind: 'workflow',
        ...selected,
        lineageId: selected.lineageId,
        split: plan.split,
        branchId: point?.branchId ?? (point === undefined ? 'unknown' : 'main'),
        primaryView: true,
      },
      caseFacts:
        source === undefined
          ? null
          : {
              familyId: selected.lineageId,
              split: plan.split,
              provenance: source.provenance.source,
              path: resolve(
                source.directory,
                plan.split,
                selected.group,
                'workflows.json',
              ),
              challenge: null,
              challengeVerified: false,
              source: 'dataset',
              conflictsWithDataset: reasons.length > 0,
            },
      reference: { ...reference, reasons: [...reasons, ...reference.reasons] },
    });
  }
  const unique = new Map<string, WorkflowMetricSource>();
  if (problems.length === 0)
    for (const source of sources)
      unique.set(
        JSON.stringify([source.workflow.group, source.workflow.rootId]),
        {
          workflow: source.document,
          group: source.workflow.group,
          split: source.split,
          path: resolve(
            source.directory,
            source.split,
            source.workflow.group,
            'workflows.json',
          ),
        },
      );
  return { cells, sources: [...unique.values()], problems };
}
