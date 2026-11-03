/** Synthetic metric observations. These do not claim to be workflow runner artifacts. */
import { evaluateReview } from '../../../src/review-contract/index.js';
import type { ReviewOutcome } from '../../../src/review-contract/index.js';
import type { CellRecord, CellState } from '../../../evals/src/run/types.js';
import { cellFactsOf } from '../../../evals/src/metrics/cell.js';
import type { CellFacts } from '../../../evals/src/metrics/cell.js';
import type { MetricReference } from '../../../evals/src/metrics/references.js';
import type { MetricSource } from '../../../evals/src/metrics/source.js';
import type {
  BehaviourReference,
  LabelTarget,
} from '../../../evals/src/data/types.js';
import { approvedTarget, VERSIONS } from '../fixtures/documents.js';

export function scored(risk: number, authorization: number): ReviewOutcome {
  return evaluateReview({ scores: { source: 'chat', risk, authorization } });
}
export const M0: ReviewOutcome = {
  status: 'insufficient-material',
  gaps: [{ source: 'synthetic', reason: 'missing' }],
  reason: 'missing',
  diagnostic: null,
};
export const FAILED: ReviewOutcome = {
  status: 'review-failure',
  failures: [],
  reason: 'synthetic provider failure',
  diagnostic: null,
};

export function metricReference(
  behaviour: BehaviourReference | null,
  source: MetricReference['source'] = 'human',
  target: Partial<LabelTarget> = {},
): MetricReference {
  return {
    source,
    basis: 'independent-behaviour',
    referenceId: 'synthetic-reference',
    humanConfirmed: source === 'human' || source === 'human-inherited',
    behaviourEligible: source !== 'unresolved' && behaviour !== null,
    scoringEligible: source !== 'unresolved',
    binding: {
      inputHash: 'synthetic',
      promptFingerprint: 'synthetic-view',
      credentials: false,
      versions: VERSIONS,
    },
    reasons: source === 'unresolved' ? ['not-annotated'] : [],
    target:
      source === 'unresolved'
        ? null
        : approvedTarget({ behaviourReference: behaviour, ...target }),
    consensus:
      source === 'model-consensus'
        ? {
            n: 4,
            k: 3,
            returned: 4,
            valid: 4,
            missing: 0,
            failed: 0,
            branch: 'n-minus-one',
            maxDeviation: [1, 1],
          }
        : null,
  };
}

export function metricCell(
  id: string,
  options: {
    readonly outcome?: ReviewOutcome | null;
    readonly status?: CellState['status'];
    readonly missing?: boolean;
    readonly reference?: MetricReference;
    readonly repeat?: number;
    readonly target?: string;
    readonly source?: MetricSource;
    readonly entryPoint?: 'direct-service' | 'host-chain';
  } = {},
): CellFacts {
  const outcome =
    options.outcome === undefined ? scored(3, 10) : options.outcome;
  const status = options.status ?? 'reviewed';
  const repeat = options.repeat ?? 1;
  const targetId = options.target ?? 'target-a';
  const reference = options.reference ?? metricReference('allow');
  const state: CellState = {
    cellId: `${id}-${targetId}-${String(repeat)}`,
    caseId: id,
    targetId,
    protocol: 'chat',
    repeat,
    record: `records/${id}.json`,
    status,
    attempts: 0,
    stopReason: null,
  };
  const notRecorded =
    options.missing === true ||
    ['not-run', 'unsupported', 'budget-exhausted', 'unresolvable'].includes(
      status,
    );
  const record: CellRecord | null = notRecorded
    ? null
    : {
        documentVersion: 'eval-cell-record-v1',
        runId: 'synthetic-metrics',
        cellId: state.cellId,
        createdAt: '2026-11-02',
        case: {
          caseId: id,
          familyId: 'synthetic-family',
          split: 'dev',
          provenanceSource: 'synthetic',
          inputHash: 'synthetic',
        },
        execution: {
          origin: repeat > 1 ? 'repeat' : 'original',
          repeat,
          transport: 'offline',
        },
        entryPoint: {
          kind: options.entryPoint ?? 'direct-service',
          materialChain: 'case-input',
          detail: 'synthetic metric fixture, not workflow runner proof',
        },
        target: {
          targetId,
          provider: 'offline',
          configuredModel: 'synthetic',
          modelVersion: null,
          protocol: 'chat',
          protocolName: 'fixture',
          responseModel: null,
          costTier: 'unknown',
        },
        abandonment: null,
        material: {
          inputHash: 'synthetic',
          promptFingerprint: 'synthetic',
          estimatedInputTokens: 10,
          maxInputTokens: 10000,
          truncatedSegments: [],
          completenessStatus:
            outcome?.status === 'insufficient-material'
              ? 'insufficient'
              : 'complete',
          blockingGaps: [],
          missing: [],
          notices: [],
        },
        status: status === 'not-run' ? 'failed' : status,
        stopReason: null,
        outcome,
        attempts:
          outcome?.status === 'insufficient-material'
            ? []
            : [
                {
                  attemptId: `${state.cellId}:1`,
                  callId: id,
                  attempt: 1,
                  backend: 'chat',
                  protocol: 'fixture',
                  request: {},
                  responseText: '{}',
                  parsed: {},
                  error:
                    outcome?.status === 'review-failure'
                      ? outcome.reason
                      : null,
                  failureKind:
                    outcome?.status === 'review-failure'
                      ? 'provider-refusal'
                      : null,
                  startedAt: 0,
                  durationMs: 1,
                  estimatedInputTokens: 10,
                  rawUsage: null,
                  normalizedUsage: null,
                  kind: 'initial',
                },
              ],
        usage: null,
        cost: {
          status: 'not-computed',
          amount: null,
          currency: null,
          reason: 'synthetic',
        },
        timing: { startedAt: 0, durationMs: 1 },
        versions: {
          contract: VERSIONS.contract,
          prompt: 'fixture',
          usageMapping: 'review-usage-v1',
          plan: 'eval-run-plan-v1',
          artifact: 'eval-run-artifact-v1',
          implementation: 'fixture',
        },
        notes: [],
      };
  const base = cellFactsOf({
    state,
    record,
    dataset: {
      status: 'absent',
      datasetId: null,
      manifest: null,
      cases: new Map(),
      labels: new Map(),
      inspection: null,
      reviews: [],
      contestedCases: new Set(),
      problems: [],
      findings: [],
    },
  });
  return {
    ...base,
    source: options.source ?? {
      kind: 'workflow',
      rootId: 'root-a',
      lineageId: 'lineage-a',
      pointId: id,
      viewId: `${id}-view`,
      group: 'f01',
      split: 'dev',
      branchId: 'main',
      primaryView: true,
    },
    evaluationReference: reference,
    labelStatus:
      options.source?.kind === 'legacy' ? base.labelStatus : 'not-applicable',
    reference: reference.behaviourEligible
      ? (reference.target?.behaviourReference ?? null)
      : null,
  };
}

export function mixedCells(): readonly CellFacts[] {
  const allowed = { risk: [3], authorization: [10] } as const;
  const denied = { risk: [3], authorization: [1] } as const;
  return [
    metricCell('a', {
      reference: metricReference('deny', 'human', { allowed: denied }),
    }),
    metricCell('b', {
      reference: metricReference('escalate', 'human-inherited', {
        allowed: { risk: [7], authorization: [9] },
      }),
    }),
    metricCell('c', {
      outcome: scored(3, 1),
      reference: metricReference('allow', 'model-consensus', { allowed }),
    }),
    metricCell('d', {
      outcome: scored(7, 9),
      reference: metricReference('allow', 'human', { allowed }),
    }),
    metricCell('e', {
      outcome: scored(7, 9),
      reference: metricReference('deny', 'human', { allowed: denied }),
    }),
    metricCell('f', {
      outcome: FAILED,
      reference: metricReference('allow', 'human', { allowed }),
    }),
    metricCell('g', {
      outcome: M0,
      reference: metricReference('insufficient-material', 'human', {
        allowed: { risk: null, authorization: null },
      }),
    }),
    metricCell('h', { reference: metricReference(null, 'unresolved') }),
    metricCell('i', {
      status: 'budget-exhausted',
      reference: metricReference('allow', 'human', { allowed }),
    }),
    metricCell('j', {
      status: 'unsupported',
      reference: metricReference('allow', 'model-consensus', { allowed }),
    }),
    metricCell('k', {
      missing: true,
      reference: metricReference('allow', 'human', { allowed }),
    }),
    metricCell('l', {
      status: 'not-run',
      reference: metricReference('allow', 'human', { allowed }),
    }),
  ];
}
