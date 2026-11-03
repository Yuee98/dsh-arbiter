/**
 * Immutable review input construction.
 *
 * One snapshot is built per review and then reused for prompt rendering,
 * auditing and the detail view. It records selection, truncation and missing
 * sources rather than re-reading a moving session later. Truncation and missing
 * material are input facts: they never throw, never change the review chain and
 * never decide the outcome by themselves.
 *
 * A bounded source read and the host/workflow adapters feed one native-order
 * event selector. Guidance and completeness describe the same captured material;
 * the existing input budget then records exactly what was submitted.
 * No source classification or protection marker decides authorization.

 */

import type {
  ArbiterConfig,
  DerivedFacts,
  HistoryStatus,
  PriorVerdictItem,
  ReviewSnapshot,
  SessionKind,
} from './types.js';
import type {
  AgentLike,
  SessionLike,
  SessionsLike,
  SessionEventLike,
} from './snapshot/types.js';
import type { CompletenessInput } from './snapshot/completeness.js';
import {
  buildCompleteness,
  missingLines,
  NO_TRIMS,
} from './snapshot/completeness.js';
import { guidanceMaterials } from './snapshot/guidance.js';
import type { ReviewEventSources, ReviewPrefix } from './types.js';
import type { ProjectRulesResult } from './snapshot/guidance.js';
import { hostEventSource } from './snapshot/host-events.js';
import {
  buildEventPrefix,
  prefixCompatibility,
  prefixProtectedGaps,
} from './snapshot/prefix.js';
import {
  captureSnapshotSources,
  redactSnapshotSources,
  type SnapshotSources,
} from './snapshot/sources.js';
import { redactSnapshot, bindSnapshotRedactor } from './snapshot/redaction.js';
import { workflowRedactor } from './snapshot/workflow.js';
import type { CredentialRedactor } from './reviewer/credential-redactor.js';
import type { ToolResultSourceReader } from './snapshot/tool-results.js';
import { truncateSnapshot } from './snapshot/budget.js';
import type { BudgetRenderers } from './snapshot/budget-measure.js';
import { redactCompletenessInput } from './snapshot/material-redaction.js';
export type {
  SessionEventLike,
  SessionLike,
  AgentLike,
  SessionsLike,
} from './snapshot/types.js';
export { materialAvailabilityOf } from './snapshot/completeness.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export interface SnapshotOptions {
  readonly toolResults?: ToolResultSourceReader;
  readonly budgetRenderers?: BudgetRenderers;
  /** A captured, allowlisted source adapter (workflow evals); host calls omit it. */
  readonly eventSources?: ReviewEventSources;
  readonly projectRulesMaterial?: ProjectRulesResult;
  readonly agent: AgentLike;
  readonly sessions?: SessionsLike;
  readonly tool: string;
  readonly arguments: unknown;
  readonly callId: string;
  readonly cwd: string;
  readonly config: ArbiterConfig;
  readonly facts: DerivedFacts | null;
  readonly hint?: string;
  /**
   * The turn the host announced and has not closed.
   *
   * The gate tracks it from `turn/start` because the pending call's own event is
   * written after the decision. Omitted means no turn was announced, and the
   * turn is then resolved from the log alone.
   */
  readonly turn?: number | null;
  readonly priorVerdicts: readonly PriorVerdictItem[];
  readonly sessionRecordGap: string | null;
  /**
   * How complete the prior-verdict window is.
   *
   * Omitted means the caller supplied a plain window with no recovery claim, and
   * the snapshot reports it as a known-complete selection rather than inventing
   * a gap that was never observed.
   */
  readonly historyStatus?: HistoryStatus;
  /** The revision this request is assembled under; recorded with the snapshot. */
  readonly configRevision: string;
}

export interface BuiltSnapshot {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
}

/**
 * The status of a window the caller assembled itself.
 *
 * A direct caller (a test, or a review that already knows its window) supplies
 * entries without a recovery read, so nothing is claimed about completeness
 * beyond what the window itself shows.
 */
function defaultHistoryStatus(): HistoryStatus {
  return {
    coverage: 'known-empty',
    windowTruncated: false,
    reason: null,
    sources: {
      memory: { read: 0, unavailable: null },
      session: { read: 0, unavailable: null },
      audit: { read: 0, unavailable: null },
    },
    reset: false,
  };
}

/**
 * Describe what this submission can say about prior verdicts.
 *
 * Coverage and capacity are separate facts, so an absent history is never
 * silently presented as a clean one: a window a source could not fill, a chain
 * two sources disagree on, and a session that genuinely had no prior verdict are
 * different facts, and only the last one means "nothing happened here".
 */
function historyGap(status: HistoryStatus): string[] {
  switch (status.coverage) {
    case 'known-empty':
    case 'complete':
      // A complete window may still be a cut one; that is the capacity fact
      // reported through `historyTruncated`, not a missing source.
      return [];
    case 'partial':
      return [
        `prior verdict history is incomplete: ${status.reason ?? 'some entries could not be fully accounted for'}`,
      ];
    case 'unknown':
      return [
        `prior verdict history could not be recovered: ${status.reason ?? 'no source answered'}, so whether this session has earlier verdicts is unknown`,
      ];
  }
}

/**
 * Compose the plugin-owned feedback hint for a truncated or incomplete
 * submission. It states an input fact and offers recovery options; it never
 * claims that truncation caused a decision.
 */
export function truncationFeedback(snapshot: ReviewSnapshot): string | null {
  const parts: string[] = [];
  if (snapshot.action.truncated !== undefined) {
    const { originalChars, retainedChars } = snapshot.action.truncated;
    parts.push(
      `this call's submitted program was truncated by the input budget (${String(originalChars)} characters, ${String(retainedChars)} submitted)`,
    );
  }
  if (snapshot.budget.truncatedSegments.includes('EVIDENCE')) {
    parts.push('authorization evidence was trimmed by the input budget');
  }
  if (parts.length === 0) return null;
  return `Input completeness: ${parts.join('; ')}. Shortening the program or splitting it into smaller calls may allow a complete review.`;
}

function sessionKindOf(session: SessionLike): SessionKind {
  const header = session.header ?? {};
  return header.origin === 'subagent' || header.parentSession !== undefined
    ? 'subagent'
    : 'main';
}

function actionOf(tool: string, args: unknown): ReviewSnapshot['action'] {
  return {
    name: tool,
    arguments: structuredClone(args),
    ...(isRecord(args) && typeof args['program'] === 'string'
      ? { programText: args['program'] }
      : {}),
  };
}

function captureEventSources(
  options: SnapshotOptions,
  captured: SnapshotSources,
) {
  const session = options.agent.session;
  const parentId = session.header?.parentSession;
  const log = captured.log;
  const identity = { turn: captured.turn };
  const parentLog = captured.parentLog ?? null;
  const sources: ReviewEventSources = captured.eventSources ?? {
    local: hostEventSource(log, session.id ?? 'unknown', parentId),
    parent:
      parentId === undefined
        ? null
        : parentLog === null
          ? {
              status: {
                sessionId: parentId,
                status: 'unavailable' as const,
                cutoff: null,
                fromSeq: null,
                reason: 'direct parent session is unavailable',
                access: 'snapshot' as const,
              },
              events: [],
            }
          : hostEventSource(parentLog, parentId, undefined, true),
  };
  return {
    sources,
    identity,
    parentCompaction: parentLog?.own.some(isCheckpointEvent) ?? false,
  };
}

function isCheckpointEvent(event: SessionEventLike): boolean {
  return (
    event.type === 'user/message' &&
    isRecord(event.data) &&
    isRecord(event.data['source']) &&
    event.data['source']['kind'] === 'compact-checkpoint'
  );
}

function parentPresence(
  prefix: ReviewPrefix,
  compacted: boolean,
): boolean | null {
  const source = prefix.parent;
  if (source === null) return null;
  if (source.events.some((event) => event.kind === 'human')) return true;
  if (
    source.status.status !== 'complete' &&
    source.status.status !== 'known-empty'
  )
    return null;
  return compacted || source.status.compacted === true ? null : false;
}

function describeEvents(
  options: SnapshotOptions,
  prefix: ReviewPrefix,
  projectRules: ProjectRulesResult,
  parentCompaction: boolean,
): Omit<CompletenessInput, 'trimmed'> {
  const parentSource = prefix.parent;
  const history = options.historyStatus ?? defaultHistoryStatus();
  const compatibility = prefixCompatibility(prefix);
  return {
    truncatedHumanEvidence: false,
    sourceObservations: prefix.omissions
      .filter((entry) => entry.cause === 'read')
      .map((entry) => ({
        source:
          entry.sessionId === prefix.local.status.sessionId
            ? ('tool-window' as const)
            : ('parent-human' as const),
        kind: 'truncated' as const,
        reason: entry.reason,
        blocking: false,
      })),
    protectedEvidenceDropped: prefixProtectedGaps(prefix),
    historyTruncated: history.windowTruncated,
    sessionReadable: prefix.local.status.status !== 'unavailable',
    sessionError: prefix.local.status.reason,
    parentRequired: options.agent.session.header?.parentSession !== undefined,
    parentReadable:
      parentSource !== null && parentSource.status.status !== 'unavailable',
    parentLive: parentSource !== null,
    parentError: parentSource?.status.reason ?? null,
    compaction: prefix.local.status.compacted === true,
    parentCompaction:
      parentCompaction || parentSource?.status.compacted === true,
    projectRules: {
      enabled: options.config.context.projectRules.enabled,
      present: projectRules.material.present,
      missing: projectRules.missing,
      unreadable: projectRules.unreadable,
    },
    sessionRecordGap: options.sessionRecordGap,
    historyGap: historyGap(history),
    evidenceCount: compatibility.evidence.length,
    evidenceKnownEmpty:
      (prefix.local.status.status === 'complete' ||
        prefix.local.status.status === 'known-empty') &&
      prefix.local.status.compacted !== true,
    earlierTurnCalls: 0,
    windowGap: null,
    hasToolCalls: compatibility.context.length > 0,
  };
}

/** Shared source assembly; compatibility arrays derive from this exact prefix. */
function assembleSnapshot(
  options: SnapshotOptions,
  captured: SnapshotSources,
  redactor: CredentialRedactor,
): {
  readonly base: Omit<ReviewSnapshot, 'budget'>;
  readonly material: Omit<CompletenessInput, 'trimmed'>;
} {
  const session = options.agent.session;
  const parentId = session.header?.parentSession;
  const { sources, identity, parentCompaction } = captureEventSources(
    options,
    captured,
  );
  const prefix = buildEventPrefix(sources, options.callId);
  const compatibility = prefixCompatibility(prefix);
  const history = options.historyStatus ?? defaultHistoryStatus();
  const projectRules = captured.project;
  const guidance = guidanceMaterials(
    options.config.context.customRules,
    projectRules,
    redactor,
  );
  const parentAuthorizationPresent = parentPresence(prefix, parentCompaction);
  const truncated = history.windowTruncated || prefix.omissions.length > 0;
  const material = describeEvents(
    options,
    prefix,
    projectRules,
    parentCompaction,
  );
  const completeness = buildCompleteness({ ...material, trimmed: NO_TRIMS });
  const base: Omit<ReviewSnapshot, 'budget'> = {
    version: 1,
    createdAt: captured.createdAt,
    configRevision: options.configRevision,
    callId: options.callId,
    sessionId: session.id ?? 'unknown',
    sessionKind: sessionKindOf(session),
    ...(parentId === undefined ? {} : { parentSessionId: parentId }),
    prefix,
    tool: options.tool,
    cwd: options.cwd,
    turn: identity.turn,
    action: actionOf(options.tool, options.arguments),
    facts:
      options.facts === null
        ? null
        : {
            ...options.facts,
            parentAuthorizationPresent,
            historyTruncated: truncated || options.facts.historyTruncated,
          },
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    projectRules: guidance.projectText,
    customRules: guidance.customRules,
    materials: guidance.materials,
    ...compatibility,
    evidenceTruncated: prefix.omissions.length > 0,
    parentAuthorizationPresent,
    contextTruncated: truncated,
    priorVerdicts: [...options.priorVerdicts].sort(
      (left, right) =>
        right.ts - left.ts || right.callId.localeCompare(left.callId),
    ),
    historyTruncated: truncated,
    historyStatus: history,
    completeness,
    missing: missingLines(completeness),
  };
  // Budget candidates rebuild diagnostics from this same sanitized material.
  redactor.discover(material);
  const safeBase = redactSnapshot(base, redactor);
  return {
    base: safeBase,
    material: redactCompletenessInput(material, redactor),
  };
}

function capturedOptions(options: SnapshotOptions): SnapshotOptions {
  return {
    ...options,
    arguments: structuredClone(options.arguments),
    facts: structuredClone(options.facts),
    priorVerdicts: structuredClone(options.priorVerdicts),
    config: structuredClone(options.config),
    ...(options.budgetRenderers === undefined
      ? {}
      : {
          budgetRenderers: {
            renderChat: options.budgetRenderers.renderChat,
            renderDecision: options.budgetRenderers.renderDecision,
          },
        }),
    ...(options.historyStatus === undefined
      ? {}
      : { historyStatus: structuredClone(options.historyStatus) }),
    ...(options.eventSources === undefined
      ? {}
      : { eventSources: structuredClone(options.eventSources) }),
    ...(options.projectRulesMaterial === undefined
      ? {}
      : {
          projectRulesMaterial: structuredClone(options.projectRulesMaterial),
        }),
  };
}

/** Capture once; known credentials rebuild from the same frozen source. */
export async function prepareReviewSnapshot(
  options: SnapshotOptions,
  workflow?: CredentialRedactor,
): Promise<{
  readonly bundle: BuiltSnapshot;
  readonly rebuild: (known?: readonly string[]) => BuiltSnapshot;
}> {
  const input = capturedOptions(options);
  const sources = await captureSnapshotSources(input);
  const context =
    workflow ?? workflowRedactor(input.agent.session, input.sessions);
  const rebuild = (known: readonly string[] = []): BuiltSnapshot => {
    context.addKnown(known);
    const redactor = context.fork();
    const cleaned = redactSnapshotSources(sources, input, redactor);
    const { base, material } = assembleSnapshot(input, cleaned, redactor);
    const requested = truncateSnapshot(
      base,
      input.config.context.maxInputTokens,
      material,
      input.config.context.targetInputTokens,
      input.budgetRenderers,
    );
    bindSnapshotRedactor(requested.snapshot, redactor);
    return {
      ...requested,
      estimatedInputTokens: requested.snapshot.budget.estimatedInputTokens,
    };
  };
  return { bundle: rebuild(), rebuild };
}

/** Build the immutable snapshot, prompt text and token estimate for one review. */
export async function buildReviewSnapshot(
  options: SnapshotOptions,
): Promise<BuiltSnapshot> {
  return (await prepareReviewSnapshot(options)).bundle;
}
