/**
 * Immutable review input construction.
 *
 * One snapshot is built per review and then reused for prompt rendering,
 * auditing and the detail view. It records selection, truncation and missing
 * sources rather than re-reading a moving session later. Truncation and missing
 * material are input facts: they never throw, never change the review chain and
 * never decide the outcome by themselves.
 *
 * The material is assembled from five readers, each owning one question:
 *
 *   - `log.ts`          — what the session log says, read once, split by session.
 *   - `window.ts`       — the current turn's tool history, in order.
 *   - `evidence.ts`     — human authorization and restrictions, across turns.
 *   - `assemble.ts`     — the parent chain and the layer-preserving merge.
 *   - `guidance.ts`     — the two configured guidance sources.
 *
 * `completeness.ts` then reports what they observed, which is the M0 status the
 * decision layer consumes. This module only wires them together and describes
 * the outcome; it never interprets authorization itself.
 */

import type {
  ArbiterConfig,
  DerivedFacts,
  HistoryStatus,
  PriorVerdictItem,
  ReviewSnapshot,
  SessionKind,
} from './types.js';
import type { AgentLike, SessionLike, SessionsLike } from './snapshot/types.js';
import { checkpointEvents } from './snapshot/evidence.js';
import { assembleEvidence } from './snapshot/assemble.js';
import type { CompletenessInput } from './snapshot/completeness.js';
import {
  buildCompleteness,
  missingLines,
  NO_TRIMS,
} from './snapshot/completeness.js';
import { guidanceMaterials, readProjectRules } from './snapshot/guidance.js';
import { currentTurnOf, toolWindow } from './snapshot/window.js';
import { readSessionLog } from './snapshot/log.js';
import { truncateSnapshot } from './snapshot/budget.js';
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

interface HistoryWindow {
  readonly selectedCalls: readonly ReviewSnapshot['context'][number][];
  readonly selectedVerdicts: readonly PriorVerdictItem[];
  readonly truncated: boolean;
}

/**
 * Select the tool calls and prior verdicts that share one capacity window.
 *
 * They compete for the same slots by recency — a long turn would otherwise push
 * the very denials this call should see out of the request — and the submitted
 * calls read oldest first, because they are the steps this call follows.
 */
function historyWindow(
  toolCalls: readonly ReviewSnapshot['context'][number][],
  priorVerdicts: readonly PriorVerdictItem[],
  maxItems: number,
): HistoryWindow {
  const combined = [
    ...toolCalls.map((call) => ({ kind: 'tool' as const, ts: call.ts, call })),
    ...priorVerdicts.map((verdict) => ({
      kind: 'verdict' as const,
      ts: verdict.ts,
      verdict,
      callId: verdict.callId,
    })),
  ]
    // Newest first, with a deterministic tie-break. Two verdicts settled in the
    // same millisecond otherwise keep whatever order the source happened to
    // produce, which would make the submitted history depend on the source
    // rather than on the decision.
    .sort((left, right) => {
      if (left.ts !== right.ts) return right.ts - left.ts;
      const leftId = 'callId' in left ? left.callId : '';
      const rightId = 'callId' in right ? right.callId : '';
      return leftId < rightId ? 1 : leftId > rightId ? -1 : 0;
    })
    .slice(0, maxItems);
  return {
    // Selection competed on recency; the submitted history reads oldest first.
    selectedCalls: combined
      .flatMap((entry) => (entry.kind === 'tool' ? [entry.call] : []))
      .sort((left, right) => left.ts - right.ts),
    selectedVerdicts: combined.flatMap((entry) =>
      entry.kind === 'verdict' ? [entry.verdict] : [],
    ),
    truncated: combined.length < toolCalls.length + priorVerdicts.length,
  };
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
    arguments: args,
    ...(isRecord(args) && typeof args['program'] === 'string'
      ? { programText: args['program'] }
      : {}),
  };
}

/** Everything the completeness report needs to describe this submission. */
interface MaterialDescriptionOptions {
  readonly log: ReturnType<typeof readSessionLog>;
  readonly evidence: Awaited<ReturnType<typeof assembleEvidence>>;
  readonly history: HistoryStatus;
  readonly window: ReturnType<typeof toolWindow>;
  readonly identity: ReturnType<typeof currentTurnOf>;
  readonly truncated: boolean;
  readonly parentId: string | undefined;
  readonly contextConfig: ArbiterConfig['context'];
  readonly projectRules: Awaited<ReturnType<typeof readProjectRules>>;
  readonly sessionRecordGap: string | null;
}

function describeMaterial(
  options: MaterialDescriptionOptions,
): Omit<CompletenessInput, 'trimmed'> {
  const { evidence, log, window } = options;
  return {
    truncatedHumanEvidence: evidence.truncatedHumanEvidence,
    protectedEvidenceDropped: evidence.merged.protectedDropped.length > 0,
    historyTruncated: options.truncated,
    sessionReadable: log.readable,
    sessionError: log.error,
    parentRequired: options.parentId !== undefined,
    parentReadable: evidence.parentReadable,
    parentLive: evidence.parentLive,
    parentError: evidence.parentError,
    compaction: evidence.compaction,
    parentCompaction: evidence.parentCompaction,
    projectRules: {
      enabled: options.contextConfig.projectRules.enabled,
      present: options.projectRules.material.present,
      missing: options.projectRules.missing,
    },
    sessionRecordGap: options.sessionRecordGap,
    historyGap: historyGap(options.history),
    evidenceCount: evidence.merged.evidence.length,
    earlierTurnCalls: window.earlierTurnCalls,
    windowGap: options.identity.gap,
    hasToolCalls: window.logCallCount > 0,
  };
}

/** The snapshot's non-budget half, before the input budget trims it. */
interface SnapshotParts {
  readonly base: Omit<ReviewSnapshot, 'budget'>;
  readonly material: Omit<CompletenessInput, 'trimmed'>;
}

/**
 * Assemble every material reader's output into one snapshot.
 *
 * Kept apart from `buildReviewSnapshot` so the budget step has one obvious input:
 * the assembled material and the description of what it could not include.
 */
async function assembleSnapshot(
  options: SnapshotOptions,
): Promise<SnapshotParts> {
  const session = options.agent.session;
  const parentId = session.header?.parentSession;
  const contextConfig = options.config.context;
  const log = readSessionLog(session);
  const evidence = assembleEvidence(log, {
    session,
    parentId,
    sessions: options.sessions,
    contextConfig,
  });
  const identity = currentTurnOf(log, options.callId, options.turn ?? null);
  const window = toolWindow(log, {
    currentCallId: options.callId,
    announcedTurn: options.turn ?? null,
    maxItems: contextConfig.historyMaxItems,
    argumentMaxChars: contextConfig.toolCallArgumentMaxChars,
  });
  const history = options.historyStatus ?? defaultHistoryStatus();
  const historyWindowOf = historyWindow(
    window.calls,
    options.priorVerdicts,
    contextConfig.historyMaxItems,
  );
  // The runtime window is already trimmed to `historyMaxItems` before it gets
  // here, so this pass alone cannot see that older verdicts were dropped. The
  // history status observed that cut while selecting, and it is the only place
  // that can still report it.
  const truncated =
    historyWindowOf.truncated || history.windowTruncated || window.truncated;
  const projectRules = await readProjectRules(
    options.cwd,
    contextConfig.projectRules,
  );
  const guidance = guidanceMaterials(contextConfig.customRules, projectRules);
  const material = describeMaterial({
    log,
    evidence,
    history,
    window,
    identity,
    truncated,
    parentId,
    contextConfig,
    projectRules,
    sessionRecordGap: options.sessionRecordGap,
  });
  const facts: DerivedFacts | null =
    options.facts === null
      ? null
      : {
          ...options.facts,
          parentAuthorizationPresent: evidence.parentAuthorizationPresent,
          historyTruncated: truncated || options.facts.historyTruncated,
          overlapsDeniedEffect: options.facts.overlapsDeniedEffect,
        };
  const completeness = buildCompleteness({ ...material, trimmed: NO_TRIMS });
  const base: Omit<ReviewSnapshot, 'budget'> = {
    version: 1,
    createdAt: Date.now(),
    configRevision: options.configRevision,
    callId: options.callId,
    sessionId: session.id ?? 'unknown',
    sessionKind: sessionKindOf(session),
    ...(parentId === undefined ? {} : { parentSessionId: parentId }),
    tool: options.tool,
    cwd: options.cwd,
    turn: identity.turn,
    action: actionOf(options.tool, options.arguments),
    facts,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    projectRules: guidance.projectText,
    customRules: guidance.customRules,
    materials: guidance.materials,
    evidence: evidence.merged.evidence,
    evidenceTruncated: evidence.merged.truncated,
    parentAuthorizationPresent: evidence.parentAuthorizationPresent,
    context: historyWindowOf.selectedCalls,
    checkpoints: checkpointEvents(log, contextConfig.checkpointMaxItems),
    contextTruncated: truncated,
    priorVerdicts: historyWindowOf.selectedVerdicts,
    historyTruncated: truncated,
    historyStatus: history,
    completeness,
    missing: missingLines(completeness),
  };
  return { base, material };
}

/** Build the immutable snapshot, prompt text and token estimate for one review. */
export async function buildReviewSnapshot(
  options: SnapshotOptions,
): Promise<BuiltSnapshot> {
  const { base, material } = await assembleSnapshot(options);
  const requested = truncateSnapshot(
    base,
    options.config.context.maxInputTokens,
    material,
  );
  return {
    snapshot: requested.snapshot,
    system: requested.system,
    user: requested.user,
    estimatedInputTokens: requested.snapshot.budget.estimatedInputTokens,
  };
}
