/** Only existing classifier/diagnostic results and bounded evidence enter public rows. */
import { classifyCell } from './behaviour.js';
import type { CellFacts } from './cell.js';
import type { RunPlan } from '../run/types.js';
import { pairStats } from './diagnostics.js';
import { canonicalJson } from '../data/hash.js';
import { legalPairs } from '../data/eligibility.js';
import { sameAnnotationView } from '../data/annotation-binding.js';
import type {
  ComparisonCell,
  ComparisonMeasurement,
} from './version-comparison-types.js';

export function measurementOf(cell: CellFacts): ComparisonMeasurement {
  const pairs = pairStats([cell]);
  return {
    classification: classifyCell(cell),
    behaviour: cell.engineWord,
    reference: cell.reference,
    source: cell.evaluationReference.source,
    referenceId: cell.evaluationReference.referenceId,
    behaviourEligible: cell.evaluationReference.behaviourEligible,
    scoringEligible: cell.evaluationReference.scoringEligible,
    pairHit: pairs.labeled === 0 ? null : pairs.exactPair === 1,
    risk: cell.engine.risk,
    authorization: cell.engine.authorization,
  };
}
export function comparisonCell(
  original: CellFacts,
  common: CellFacts,
  plan: RunPlan,
): ComparisonCell {
  const target = plan.targets.find(
    (entry) => entry.targetId === original.targetId,
  );
  const chat = original.protocol === 'chat' ? target?.chat : null;
  return {
    settings: {
      evidence: 'frozen-plan-only',
      temperature: chat?.temperature ?? null,
      maxTokens: chat?.maxTokens ?? null,
      maxRepairRetries: chat?.maxRepairRetries ?? null,
      timeoutMs:
        (original.protocol === 'chat'
          ? target?.chat?.timeoutMs
          : target?.decision?.timeoutMs) ?? null,
      reasoningEffort:
        chat?.reasoningEffort === undefined
          ? null
          : (['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].find(
              (mode) => mode === chat.reasoningEffort,
            ) ?? 'unknown'),
    },
    cellId: original.cellId,
    source: original.source,
    targetId: original.targetId,
    protocol: original.protocol,
    repeat: original.repeat,
    standing: original.standing,
    indexStatus: original.indexStatus,
    completed:
      original.indexStatus === 'reviewed' &&
      original.record?.status === 'reviewed',
    model: original.model,
    inputHash: original.inputHash,
    promptFingerprint: original.record?.material?.promptFingerprint ?? null,
    viewFingerprint:
      common.evaluationReference.binding?.promptFingerprint ?? null,
    maxInputTokens: original.record?.material?.maxInputTokens ?? null,
    targetInputTokens: original.record?.material?.targetInputTokens ?? null,
    original: measurementOf(original),
    common: measurementOf(common),
  };
}
export function evidenceVerified(cell: CellFacts): boolean {
  const sent =
    cell.record?.attempts.filter((attempt) => attempt.sent !== false) ?? [];
  const response =
    cell.engineWord === 'insufficient-material' ||
    sent.some(
      (attempt) => attempt.responseText !== null || attempt.parsed !== null,
    );
  const identity = sent.every((attempt) => {
    const request = attempt.request;
    if (request === null || typeof request !== 'object') return false;
    return (
      Reflect.get(request, 'model') === cell.model?.configured &&
      (cell.protocol !== 'chat' ||
        Reflect.get(request, 'provider') === cell.model?.provider)
    );
  });
  return (
    response &&
    identity &&
    cell.record !== null &&
    cell.indexStatus === 'reviewed' &&
    cell.record.status === cell.indexStatus &&
    cell.record.material !== null &&
    cell.record.cellId === cell.cellId &&
    cell.record.case.caseId === cell.caseId &&
    cell.record.target.targetId === cell.targetId &&
    cell.record.target.protocol === cell.protocol &&
    cell.record.execution.repeat === cell.repeat &&
    cell.model !== null &&
    cell.model.provider.trim() !== '' &&
    cell.model.configured.trim() !== '' &&
    cell.inputHash !== null &&
    cell.caseFacts !== null &&
    !cell.caseFacts.conflictsWithDataset &&
    cell.caseFacts.source !== 'record' &&
    (cell.source.kind === 'legacy' || cell.evaluationReference.binding !== null)
  );
}
/** A source change can remain the same verified effective view; credentials keep their input relationship. */
export function viewComparability(
  left: CellFacts,
  right: CellFacts,
): 'comparable' | 'different' | 'unverified' {
  if (left.inputHash === null || right.inputHash === null) return 'unverified';
  if (left.source.kind !== right.source.kind) return 'different';
  if (left.inputHash === right.inputHash) return 'comparable';
  if (left.source.kind === 'legacy') return 'different';
  const a = left.evaluationReference.binding,
    b = right.evaluationReference.binding;
  if (a === null || b === null) return 'unverified';
  if (sameAnnotationView(a, b)) return 'comparable';
  return a.promptFingerprint !== b.promptFingerprint
    ? 'different'
    : 'unverified';
}
function commonReferenceSource(left: CellFacts, right: CellFacts): boolean {
  const a = left.evaluationReference,
    b = right.evaluationReference;
  return (
    a.source !== 'unresolved' &&
    a.source === b.source &&
    a.basis === b.basis &&
    a.humanConfirmed === b.humanConfirmed &&
    (left.source.kind === 'legacy' ||
      (a.referenceId !== null && a.referenceId === b.referenceId)) &&
    canonicalJson(a.binding?.versions ?? null) ===
      canonicalJson(b.binding?.versions ?? null) &&
    canonicalJson(a.consensus) === canonicalJson(b.consensus)
  );
}
/** Common provenance is shared; behaviour and legal scoring pairs have independent applicability. */
export function commonReferenceEqual(
  left: CellFacts,
  right: CellFacts,
  metric: 'behaviour' | 'scoring' = 'behaviour',
): boolean {
  const a = left.evaluationReference,
    b = right.evaluationReference;
  if (
    !commonReferenceSource(left, right) ||
    a.target === null ||
    b.target === null
  )
    return false;
  if (metric === 'behaviour')
    return (
      a.behaviourEligible &&
      b.behaviourEligible &&
      a.target.behaviourReference !== null &&
      a.target.behaviourReference === b.target.behaviourReference
    );
  if (!a.scoringEligible || !b.scoringEligible) return false;
  const pairsA = legalPairs({ target: a.target }),
    pairsB = legalPairs({ target: b.target });
  if (pairsA === null || pairsB === null) return false;
  const order = (pairs: typeof pairsA) =>
    [...pairs].sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  return canonicalJson(order(pairsA)) === canonicalJson(order(pairsB));
}
