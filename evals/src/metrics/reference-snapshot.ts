/** Read the existing #127 frozen snapshot, never a private annotation batch. */
import { readFile } from 'node:fs/promises';
import type { workflowReferences } from '../annotation/workflow-service.js';
import type { CurrentReference } from '../annotation/reference.js';
import type { Consensus } from '../annotation/consensus.js';
import { checked } from '../annotation/workflow-validation.js';
import { compileCheckers } from '../data/schemas.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import {
  legalPairs,
  mixesProhibition,
  productSize,
  versionsMatch,
} from '../data/eligibility.js';
import type { AnnotationBinding } from '../data/annotation-types.js';
import type { MetricReference } from './references.js';

export type FrozenReferenceEntry = Omit<
  CurrentReference,
  'binding' | 'consensus'
> & {
  readonly binding: AnnotationBinding | null;
  readonly consensus: Consensus | null;
  readonly error: string | null;
  readonly request: unknown;
};
export type ReferenceSnapshot = Omit<
  Awaited<ReturnType<typeof workflowReferences>>,
  'entries'
> & { readonly entries: readonly FrozenReferenceEntry[] };
const versions = {
  type: 'object',
  required: ['contract', 'rubric', 'policy'],
  properties: {
    contract: { type: 'string' },
    rubric: { type: 'string' },
    policy: { type: 'string' },
  },
  additionalProperties: false,
};
const binding = {
  type: ['object', 'null'],
  required: ['inputHash', 'promptFingerprint', 'credentials', 'versions'],
  properties: {
    inputHash: { type: 'string' },
    promptFingerprint: { type: 'string' },
    credentials: { type: 'boolean' },
    versions,
  },
  additionalProperties: false,
};
const stringArray = { type: 'array', items: { type: 'string' } };
const count = { type: 'integer', minimum: 0 };
const consensus = {
  type: ['object', 'null'],
  required: [
    'n',
    'k',
    'returned',
    'valid',
    'missing',
    'failed',
    'branch',
    'maxDeviation',
  ],
  properties: {
    n: count,
    k: count,
    returned: count,
    valid: count,
    missing: count,
    failed: count,
    branch: { enum: ['ratio', 'n-minus-one', 'both', null] },
    maxDeviation: {
      type: ['array', 'null'],
      items: { type: 'number', minimum: 0 },
      minItems: 2,
      maxItems: 2,
    },
  },
};
const entrySchema = {
  type: 'object',
  additionalProperties: false,
  required: [
    'rootId',
    'pointId',
    'viewId',
    'source',
    'humanConfirmed',
    'scoringEligible',
    'reference',
    'consensus',
    'binding',
    'reasons',
    'staleReferenceIds',
    'error',
    'request',
  ],
  properties: {
    rootId: { type: 'string' },
    pointId: { type: 'string' },
    viewId: { type: 'string' },
    source: {
      enum: ['human', 'human-inherited', 'model-consensus', 'unresolved'],
    },
    humanConfirmed: { type: 'boolean' },
    scoringEligible: { type: 'boolean' },
    reference: { type: ['object', 'null'] },
    consensus,
    binding,
    reasons: stringArray,
    staleReferenceIds: stringArray,
    error: { type: ['string', 'null'] },
    request: {},
  },
};
export async function readReferenceSnapshot(
  path: string,
): Promise<ReferenceSnapshot> {
  const snapshot = checked<ReferenceSnapshot>(
    {
      type: 'object',
      additionalProperties: false,
      required: [
        'snapshotVersion',
        'sourceCommit',
        'sourceDirty',
        'createdAt',
        'scope',
        'context',
        'entries',
      ],
      properties: {
        snapshotVersion: { const: 'workflow-references-v1' },
        sourceCommit: { type: ['string', 'null'] },
        sourceDirty: { type: ['boolean', 'null'] },
        createdAt: { type: 'string' },
        scope: {
          type: 'object',
          required: ['split', 'group'],
          additionalProperties: false,
          properties: {
            split: { enum: ['dev', 'calibration', 'holdout'] },
            group: { type: 'string', minLength: 1 },
          },
        },
        context: {
          type: 'object',
          required: [
            'protocol',
            'targetInputTokens',
            'maxInputTokens',
            'customRules',
            'projectRules',
          ],
          additionalProperties: false,
          properties: {
            protocol: { enum: ['chat', 'decision'] },
            targetInputTokens: { type: 'integer', minimum: 1 },
            maxInputTokens: { type: 'integer', minimum: 1 },
            customRules: { type: 'string' },
            projectRules: { type: ['string', 'null'] },
          },
        },
        entries: { type: 'array', items: entrySchema },
      },
    },
    JSON.parse(await readFile(path, 'utf8')) as unknown,
  );
  if (snapshot.context.targetInputTokens > snapshot.context.maxInputTokens)
    throw new Error('reference context exceeds its hard limit');
  const checkers = await compileCheckers();
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    const key = JSON.stringify([entry.rootId, entry.pointId, entry.viewId]);
    if (seen.has(key))
      throw new Error(`duplicate frozen reference identity ${key}`);
    seen.add(key);
    const reference = entry.reference;
    if (reference === null) {
      if (
        entry.source !== 'unresolved' ||
        entry.humanConfirmed ||
        entry.scoringEligible
      )
        throw new Error('missing reference must remain unresolved');
      continue;
    }
    const result = checkers.groupedLabels({
      schemaVersion: 'grouped-v1',
      records: [reference],
    });
    if (!result.ok) throw new Error(result.problems.join('; '));
    const pairs = legalPairs(reference);
    if (mixesProhibition(reference.target.allowed))
      throw new Error(
        'frozen reference mixes A1 with other authorization bands',
      );
    if (pairs === null && productSize(reference.target.allowed) > 1)
      throw new Error('frozen reference must enumerate widened pairs');
    for (const pair of reference.target.allowedPairs ?? pairs ?? [])
      if (
        !(reference.target.allowed.risk ?? []).includes(pair[0]) ||
        !(reference.target.allowed.authorization ?? []).includes(pair[1])
      )
        throw new Error('frozen reference pair is outside allowed sets');
    if (
      reference.rootId !== entry.rootId ||
      reference.pointId !== entry.pointId ||
      reference.viewId !== entry.viewId ||
      reference.source !== entry.source ||
      reference.humanConfirmed !== entry.humanConfirmed ||
      reference.scoringEligible !== entry.scoringEligible
    )
      throw new Error('frozen reference identity/source flags disagree');
    if (
      entry.source === 'unresolved' ||
      entry.binding === null ||
      reference.annotation === undefined ||
      !sameAnnotationView(reference.annotation.binding, entry.binding) ||
      !versionsMatch(reference.versions, entry.binding.versions)
    )
      throw new Error('frozen reference lacks its applicable binding');
    if (
      (entry.source === 'human' || entry.source === 'human-inherited') &&
      (!entry.humanConfirmed || reference.target.status !== 'approved')
    )
      throw new Error('human reference is not confirmed');
    if (
      entry.source === 'model-consensus' &&
      (entry.humanConfirmed || reference.target.status !== 'pending')
    )
      throw new Error(
        'model reference is provisional, never approved human gold',
      );
    const humanState = reference.annotation.humanState;
    if (
      humanState !== undefined &&
      (!['human', 'human-inherited'].includes(entry.source) ||
        humanState !== 'confirmed')
    )
      throw new Error(
        'a draft or explicit human pending state cannot be a selected reference',
      );
    if (
      humanState !== undefined &&
      (reference.target.decidedBy.trim() === '' ||
        reference.target.rationale.trim() === '' ||
        reference.target.decidedAt === null)
    )
      throw new Error(
        'explicit human annotation requires author, date and rationale',
      );
    if (
      entry.source === 'human-inherited' &&
      (reference.annotation.inheritedFrom?.trim().length ?? 0) === 0
    )
      throw new Error('inherited human reference needs its explicit origin');
  }
  return snapshot;
}
function referenceSource(source: string): MetricReference['source'] {
  return source === 'human' ||
    source === 'human-inherited' ||
    source === 'model-consensus'
    ? source
    : 'unresolved';
}

/** Actual binding is supplied by the run adapter after its own material proof, not inferred here. */
export function frozenReferenceFor(parts: {
  readonly snapshots: readonly ReferenceSnapshot[];
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly split: string;
  readonly group: string;
  readonly protocol: string;
  readonly binding: AnnotationBinding | null;
}): MetricReference {
  const candidates = parts.snapshots
    .filter(
      (snapshot) =>
        snapshot.scope.split === parts.split &&
        snapshot.scope.group === parts.group &&
        snapshot.context.protocol === parts.protocol,
    )
    .flatMap((snapshot) => snapshot.entries)
    .filter(
      (entry) =>
        entry.rootId === parts.rootId &&
        entry.pointId === parts.pointId &&
        entry.viewId === parts.viewId,
    );
  const actual = parts.binding;
  const applicable =
    actual === null
      ? []
      : candidates.filter(
          (entry) =>
            entry.binding !== null && sameAnnotationView(entry.binding, actual),
        );
  if (applicable.length > 1)
    throw new Error('ambiguous frozen reference for the same applicable view');
  const entry = applicable[0];
  const reference = entry?.reference ?? null;
  const reasons =
    entry === undefined
      ? [
          actual === null
            ? 'run-view-unverified'
            : candidates.length === 0
              ? 'frozen-reference-missing'
              : 'input-view-version-drift',
        ]
      : entry.reasons;
  const eligible =
    reference !== null &&
    entry?.source !== 'unresolved' &&
    reasons.length === 0;
  const selectedConsensus = entry?.consensus;
  return {
    source:
      eligible && entry !== undefined
        ? referenceSource(entry.source)
        : 'unresolved',
    basis: 'independent-behaviour',
    referenceId: reference?.referenceId ?? null,
    humanConfirmed: entry?.humanConfirmed ?? false,
    target: reference === null ? null : structuredClone(reference.target),
    behaviourEligible: eligible && reference.target.behaviourReference !== null,
    scoringEligible: eligible && entry?.scoringEligible === true,
    binding: actual === null ? null : structuredClone(actual),
    reasons: [...reasons],
    consensus:
      selectedConsensus === undefined || selectedConsensus === null
        ? null
        : {
            n: selectedConsensus.n,
            k: selectedConsensus.k,
            returned: selectedConsensus.returned,
            valid: selectedConsensus.valid,
            missing: selectedConsensus.missing,
            failed: selectedConsensus.failed,
            branch: selectedConsensus.branch,
            maxDeviation: selectedConsensus.maxDeviation,
          },
  };
}
