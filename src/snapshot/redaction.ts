/** Material-only projection: typed provenance/score/status metadata stays unchanged. */
import type {
  DerivedFacts,
  HistoryStatus,
  PriorVerdictItem,
  ReviewSnapshot,
} from '../types.js';
import { redactPrefix } from './prefix-redaction.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';

const CONTEXTS = new WeakMap<
  object,
  { readonly redactor: CredentialRedactor; readonly revision: number }
>();
export function snapshotRedactor(
  snapshot: object,
): CredentialRedactor | undefined {
  return CONTEXTS.get(snapshot)?.redactor;
}
export function bindSnapshotRedactor(
  snapshot: object,
  redactor: CredentialRedactor,
): void {
  CONTEXTS.set(snapshot, { redactor, revision: redactor.revision });
}
/** Retain the sent view unless newly recognized credentials require a safer copy.
 * Historical budgets continue to describe the actual send, never a new estimate.
 */
export function retainedSnapshot<T extends Omit<ReviewSnapshot, 'budget'>>(
  snapshot: T,
  redactor: CredentialRedactor,
): T {
  const prepared = CONTEXTS.get(snapshot);
  if (
    prepared?.redactor === redactor &&
    prepared.revision === redactor.revision
  )
    return snapshot;
  const copied = redactSnapshot(snapshot, redactor);
  bindSnapshotRedactor(copied, redactor);
  return copied;
}

function factsCopy(
  facts: DerivedFacts | null,
  redactor: CredentialRedactor,
): DerivedFacts | null {
  if (facts === null) return null;
  const text = (value: string) => redactor.text(value);
  return {
    ...facts,
    observed: {
      ...facts.observed,
      writes: facts.observed.writes.map(text),
      networkCommands: facts.observed.networkCommands.map(text),
      credentialPaths: facts.observed.credentialPaths.map(text),
      pipelineExec: facts.observed.pipelineExec.map((items) => items.map(text)),
    },
    opaqueReason: facts.opaqueReason === null ? null : text(facts.opaqueReason),
    unresolvedExpansions: facts.unresolvedExpansions.map(text),
    expansionRisk:
      facts.expansionRisk === null ? null : text(facts.expansionRisk),
  };
}
function priorCopy(
  item: PriorVerdictItem,
  redactor: CredentialRedactor,
): PriorVerdictItem {
  const text = (value: string) => redactor.text(value);
  return {
    ...item,
    ...(item.reason === undefined ? {} : { reason: text(item.reason) }),
    ...(item.effect?.writes === undefined
      ? {}
      : { effect: { ...item.effect, writes: item.effect.writes.map(text) } }),
    ...(item.stages === undefined
      ? {}
      : {
          stages: item.stages.map((stage) => ({
            ...stage,
            reason: stage.reason === null ? null : text(stage.reason),
          })),
        }),
    ...(item.conflicts === undefined
      ? {}
      : {
          conflicts: item.conflicts.map((conflict) => ({
            ...conflict,
            observed: conflict.observed.map(text),
          })),
        }),
  };
}
function historyCopy(
  history: HistoryStatus,
  redactor: CredentialRedactor,
): HistoryStatus {
  const nullable = (value: string | null) =>
    value === null ? null : redactor.text(value);
  const source = (item: HistoryStatus['sources']['memory']) => ({
    ...item,
    unavailable: nullable(item.unavailable),
  });
  return {
    ...history,
    reason: nullable(history.reason),
    sources: {
      memory: source(history.sources.memory),
      session: source(history.sources.session),
      audit: source(history.sources.audit),
    },
  };
}
export function redactSnapshot<T extends Omit<ReviewSnapshot, 'budget'>>(
  snapshot: T,
  redactor: CredentialRedactor,
): T {
  redactor.discover([
    snapshot.cwd,
    snapshot.materials.map((item) => item.path),
    snapshot.action.arguments,
    snapshot.action.programText,
    snapshot.facts,
    snapshot.hint,
    snapshot.projectRules,
    snapshot.customRules,
    snapshot.evidence.map((item) => [item.text, item.question]),
    snapshot.context.map((item) => item.arguments),
    snapshot.checkpoints.map((item) => item.text),
    snapshot.priorVerdicts.map((item) => [
      item.reason,
      item.effect,
      item.stages,
      item.conflicts,
    ]),
    snapshot.missing,
    snapshot.historyStatus.reason,
    Object.values(snapshot.historyStatus.sources).map(
      (source) => source.unavailable,
    ),
    snapshot.completeness.note,
    snapshot.completeness.gaps.map((gap) => gap.reason),
    snapshot.completeness.items.map((item) => item.reason),
  ]);
  const text = (value: string) => redactor.text(value);
  return {
    ...snapshot,
    ...(snapshot.prefix === undefined
      ? {}
      : { prefix: redactPrefix(snapshot.prefix, redactor) }),
    cwd: text(snapshot.cwd),
    materials: snapshot.materials.map((item) => ({
      ...item,
      ...(item.path === undefined ? {} : { path: text(item.path) }),
    })),
    action: {
      ...snapshot.action,
      arguments: redactor.value(snapshot.action.arguments),
      ...(snapshot.action.programText === undefined
        ? {}
        : { programText: text(snapshot.action.programText) }),
    },
    facts: factsCopy(snapshot.facts, redactor),
    ...(snapshot.hint === undefined ? {} : { hint: text(snapshot.hint) }),
    projectRules:
      snapshot.projectRules === null ? null : text(snapshot.projectRules),
    customRules: text(snapshot.customRules),
    evidence: snapshot.evidence.map((item) => ({
      ...item,
      text: text(item.text),
      ...(item.question === undefined ? {} : { question: text(item.question) }),
    })),
    context: snapshot.context.map((item) => ({
      ...item,
      arguments: text(item.arguments),
    })),
    checkpoints: snapshot.checkpoints.map((item) => ({
      ...item,
      text: text(item.text),
    })),
    priorVerdicts: snapshot.priorVerdicts.map((item) =>
      priorCopy(item, redactor),
    ),
    missing: snapshot.missing.map(text),
    historyStatus: historyCopy(snapshot.historyStatus, redactor),
    completeness: {
      ...snapshot.completeness,
      note:
        snapshot.completeness.note === null
          ? null
          : text(snapshot.completeness.note),
      gaps: snapshot.completeness.gaps.map((gap) => ({
        ...gap,
        reason: text(gap.reason),
      })),
      items: snapshot.completeness.items.map((item) => ({
        ...item,
        reason: text(item.reason),
      })),
    },
  };
}
