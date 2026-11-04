/** Checks spanning selected groups. No file outside that selection is opened here. */
import { legalPairs, mixesProhibition, productSize } from './eligibility.js';
import { inspectDataset } from './inspect.js';
import type { CurrentVersions, Finding } from './inspect.js';
import type { Checkers } from './schemas.js';
import type {
  DataGroup,
  WorkflowLabel,
  WorkflowOpinion,
} from './group-types.js';
import type { CaseReviews, ReviewLabel, DatasetManifest } from './types.js';
import { checkWorkflow } from './workflow-check.js';
import { sameAnnotationView } from './annotation-binding.js';
import { canonicalJson } from './hash.js';

function legacyProblems(
  group: DataGroup,
  checkers: Checkers,
  current: CurrentVersions,
  authority?: DatasetManifest,
): readonly Finding[] {
  const labels = group.labels.filter(
    (entry): entry is { path: string; document: ReviewLabel } =>
      'caseId' in entry.document,
  );
  const reviews = group.opinions.filter(
    (entry): entry is { path: string; document: CaseReviews } =>
      'caseId' in entry.document,
  );
  const versions = authority?.versions ??
    labels[0]?.document.versions ?? {
      ...current,
      policy: 'unlabelled',
    };
  const families = new Map(
    group.cases.map((entry) => [
      entry.document.familyId,
      { familyId: entry.document.familyId, split: group.split },
    ]),
  );
  const expectedFamilies = authority?.families.filter(
    (f) => f.split === group.split,
  ) ?? [...families.values()];
  const familyIds = new Set(expectedFamilies.map((f) => f.familyId));
  const expectedCases =
    authority?.cases.filter((c) => familyIds.has(c.familyId)) ??
    group.cases.map((entry) => ({
      caseId: entry.document.caseId,
      familyId: entry.document.familyId,
    }));
  const result = inspectDataset(
    {
      manifest: {
        path: `${group.split}/${group.group}`,
        document: {
          datasetId: 'grouped-legacy',
          versions,
          families: expectedFamilies,
          cases: expectedCases,
        },
      },
      cases: group.cases,
      labels,
      reviews,
      problems: [],
    },
    checkers,
    current,
    'collection',
  );
  // This is a transient table of contents for existing checks, not a stored manifest
  // or a declaration that a migrated reference has regained any qualification.
  return result.problems.map((p) =>
    p.path === 'manifest.json'
      ? {
          ...p,
          path: `${group.split}/${group.group}/cases.json#`,
          message: `authority: ${p.message}`,
        }
      : p,
  );
}

function opinionProblems(
  value: WorkflowOpinion,
  path: string,
): readonly Finding[] {
  const problems: Finding[] = [];
  const { risk, authorization, model } = value.opinion;
  const full =
    risk !== null &&
    authorization !== null &&
    value.independentBehaviour !== null;
  if (value.outcome === 'answered' && !full)
    problems.push({
      path,
      message:
        'answered opinion needs both scores and an independent behaviour',
    });
  if (
    (value.outcome === 'failed' || value.outcome === 'missing') &&
    (risk !== null ||
      authorization !== null ||
      value.independentBehaviour !== null)
  )
    problems.push({
      path,
      message: 'failed/missing opinion cannot fabricate scores or behaviour',
    });
  if (value.outcome === 'failed' && value.error === undefined)
    problems.push({ path, message: 'failed opinion needs its actual error' });
  if (value.outcome === 'partial' && full)
    problems.push({
      path,
      message: 'complete opinion must be recorded as answered',
    });
  if ((model.version === null) !== (model.versionSource === 'unknown'))
    problems.push({ path, message: 'model version and its source disagree' });
  const annotation = value.annotation;
  if (annotation !== undefined) {
    if (
      annotation.complete &&
      (annotation.pairs === null ||
        annotation.rawResponse === null ||
        value.independentBehaviour === null ||
        annotation.problems.length > 0)
    )
      problems.push({
        path,
        message:
          'complete annotation lacks its answer, raw response, or valid evidence',
      });
    if (
      annotation.registration &&
      (value.outcome !== 'missing' || annotation.rawResponse !== null)
    )
      problems.push({
        path,
        message: 'registration is a missing opinion, never a fabricated reply',
      });
    if (
      annotation.rawResponse !== null &&
      value.responseRef !==
        `opinion:${value.opinion.reviewId}#annotation/rawResponse`
    )
      problems.push({
        path,
        message: 'raw response reference does not resolve to this opinion',
      });
    const pair =
      annotation.pairs?.length === 1 ? annotation.pairs[0] : undefined;
    if (
      annotation.complete &&
      pair !== undefined &&
      (pair[0] !== risk || pair[1] !== authorization)
    )
      problems.push({
        path,
        message: 'opinion scores differ from the retained complete pair',
      });
  }
  return problems;
}

function referenceProblems(group: DataGroup): readonly Finding[] {
  const problems: Finding[] = [];
  const roots = new Map(
    group.workflows.map((entry) => [entry.document.rootId, entry.document]),
  );
  const referenceIds = new Set<string>();
  const opinionIds = new Set(
    group.opinions.flatMap((entry) =>
      'opinion' in entry.document ? [entry.document.opinion.reviewId] : [],
    ),
  );
  for (const entry of [...group.labels, ...group.opinions]) {
    const value = entry.document;
    if (!('rootId' in value)) {
      problems.push({
        path: entry.path,
        message: 'legacy references belong only in legacy-v1',
      });
      continue;
    }
    const point = roots
      .get(value.rootId)
      ?.points.find((item) => item.pointId === value.pointId);
    if (point === undefined || point.primaryViewId !== value.viewId)
      problems.push({
        path: entry.path,
        message: `wrong root/point/view binding ${value.rootId}/${value.pointId}/${value.viewId}`,
      });
    const id =
      'referenceId' in value ? value.referenceId : value.opinion.reviewId;
    const key = `${'referenceId' in value ? 'label' : 'opinion'}/${id}`;
    if (referenceIds.has(key))
      problems.push({ path: entry.path, message: `duplicate ${key}` });
    referenceIds.add(key);
    if ('opinion' in value)
      problems.push(...opinionProblems(value, entry.path));
    else {
      problems.push(...labelProblems(value, entry.path, opinionIds));
      for (const id of value.supportingOpinionIds) {
        const support = group.opinions.find(
          (candidate) =>
            'opinion' in candidate.document &&
            candidate.document.opinion.reviewId === id,
        )?.document;
        if (
          support !== undefined &&
          'rootId' in support &&
          (support.rootId !== value.rootId ||
            support.pointId !== value.pointId ||
            support.viewId !== value.viewId ||
            (value.annotation === undefined
              ? support.batchId !== value.batchId
              : support.annotation === undefined ||
                !sameAnnotationView(
                  value.annotation.binding,
                  support.annotation.binding,
                )))
        )
          problems.push({
            path: entry.path,
            message: `supporting opinion ${id} belongs to another root/point/view/batch`,
          });
      }
    }
  }
  return problems;
}

function labelProblems(
  value: WorkflowLabel,
  path: string,
  opinions: ReadonlySet<string>,
): readonly Finding[] {
  const problems: Finding[] = [];
  const humanState = value.annotation?.humanState;
  if (
    value.annotation !== undefined &&
    canonicalJson(value.versions) !==
      canonicalJson(value.annotation.binding.versions)
  )
    problems.push({
      path,
      message: 'label and annotation binding versions disagree',
    });
  if (
    humanState !== undefined &&
    humanState !== 'draft' &&
    (value.target.decidedBy.trim() === '' ||
      value.target.rationale.trim() === '' ||
      value.target.decidedAt === null)
  )
    problems.push({
      path,
      message: 'explicit human annotation requires author, date and rationale',
    });
  if (
    humanState !== undefined &&
    !['human', 'human-inherited'].includes(value.source)
  )
    problems.push({
      path,
      message: 'human annotation state requires a human source',
    });
  if (
    humanState === 'confirmed' &&
    (!value.humanConfirmed || value.target.status !== 'approved')
  )
    problems.push({
      path,
      message: 'confirmed annotation requires an approved human reference',
    });
  if (
    humanState !== undefined &&
    humanState !== 'confirmed' &&
    (value.humanConfirmed || value.scoringEligible)
  )
    problems.push({
      path,
      message:
        'draft or explicit human pending state is not confirmed/scoring eligible',
    });
  if (
    value.source === 'human-inherited' &&
    value.annotation !== undefined &&
    (value.annotation.inheritedFrom === undefined ||
      value.annotation.inheritedFrom.trim() === '')
  )
    problems.push({
      path,
      message: 'human inherited annotation needs its explicit origin',
    });
  if (
    value.humanConfirmed &&
    (!['human', 'human-inherited'].includes(value.source) ||
      value.target.status !== 'approved')
  )
    problems.push({
      path,
      message: 'human confirmation requires an approved human reference',
    });
  if (value.source === 'model-consensus' && value.target.status === 'approved')
    problems.push({
      path,
      message: 'model consensus is provisional, never human approved',
    });
  if (
    value.source === 'unresolved' &&
    (value.scoringEligible || value.humanConfirmed)
  )
    problems.push({
      path,
      message:
        'unresolved reference is neither scoring eligible nor human confirmed',
    });
  if (mixesProhibition(value.target.allowed))
    problems.push({
      path,
      message: 'authorization combines band 1 with other bands',
    });
  const pairs = legalPairs(value);
  if (pairs === null && productSize(value.target.allowed) > 1)
    problems.push({
      path,
      message:
        'enumerate allowedPairs for widened score sets; never use a Cartesian product',
    });
  for (const pair of value.target.allowedPairs ?? pairs ?? []) {
    if (
      !(value.target.allowed.risk ?? []).includes(pair[0]) ||
      !(value.target.allowed.authorization ?? []).includes(pair[1])
    )
      problems.push({
        path,
        message: `allowed pair ${String(pair[0])}/${String(pair[1])} is outside the allowed sets`,
      });
  }
  for (const id of value.supportingOpinionIds)
    if (!opinions.has(id))
      problems.push({ path, message: `unknown supporting opinion ${id}` });
  return problems;
}

export function checkGroups(
  groups: readonly DataGroup[],
  checkers: Checkers,
  current: CurrentVersions,
  authority?: DatasetManifest,
): {
  readonly problems: readonly Finding[];
  readonly findings: readonly Finding[];
} {
  const problems: Finding[] = [];
  const findings: Finding[] = [];
  const ids = new Map<string, string>();
  const clusters = new Map<string, string>();
  const origins = new Map<string, string>();
  const unique = (kind: string, id: string, path: string): void => {
    const key = `${kind}/${id}`;
    const previous = ids.get(key);
    if (previous !== undefined)
      problems.push({
        path,
        message: `${kind} ${id} is also declared at ${previous}`,
      });
    ids.set(key, path);
  };
  const cluster = (
    kind: string,
    id: string,
    split: string,
    path: string,
  ): void => {
    const key = `${kind}/${id}`;
    const previous = clusters.get(key);
    if (previous !== undefined && previous !== split)
      problems.push({
        path,
        message: `${kind} ${id} crosses splits ${previous}/${split}`,
      });
    clusters.set(key, split);
  };
  const origin = (text: string, split: string, path: string): void => {
    const previous = origins.get(text);
    if (previous !== undefined && previous !== split)
      findings.push({
        path,
        message: `origin description repeats across splits ${previous}/${split}; verify actual common source (description alone is not identity): ${text}`,
      });
    origins.set(text, split);
  };
  for (const group of groups) {
    if (group.contentSet === 'legacy-v1') {
      problems.push(...legacyProblems(group, checkers, current, authority));
      for (const entry of group.cases) {
        const value = entry.document;
        unique('root', value.caseId, entry.path);
        unique('point', value.caseId, entry.path);
        cluster('lineage', value.familyId, group.split, entry.path);
        origin(value.provenance.origin, group.split, entry.path);
        if (value.split !== group.split)
          problems.push({
            path: entry.path,
            message: `case ${value.caseId} split ${value.split} disagrees with directory ${group.split}`,
          });
      }
      for (const entry of [...group.labels, ...group.opinions])
        if (!('caseId' in entry.document))
          problems.push({
            path: entry.path,
            message: 'workflow references cannot be filed in legacy-v1',
          });
    } else {
      for (const entry of group.workflows) {
        const value = entry.document;
        unique('root', value.rootId, entry.path);
        cluster(
          'lineage',
          value.lineageId ?? value.rootId,
          group.split,
          entry.path,
        );
        if (value.provenance.sourceId !== undefined)
          cluster('source', value.provenance.sourceId, group.split, entry.path);
        origin(value.provenance.origin, group.split, entry.path);
        for (const point of value.points) {
          unique('point', point.pointId, entry.path);
          unique('view', point.primaryViewId, entry.path);
        }
        problems.push(...checkWorkflow(value, entry.path));
      }
      for (const entry of group.labels)
        if ('referenceId' in entry.document)
          unique('reference', entry.document.referenceId, entry.path);
      for (const entry of group.opinions)
        if ('opinion' in entry.document)
          unique('opinion', entry.document.opinion.reviewId, entry.path);
      problems.push(...referenceProblems(group));
    }
  }
  return { problems, findings };
}
