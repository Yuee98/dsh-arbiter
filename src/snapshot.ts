/**
 * Immutable review input construction.
 *
 * One snapshot is built per review and then reused for prompt rendering,
 * auditing and the detail view. It records selection, truncation and missing
 * sources rather than re-reading a moving session later.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArbiterConfig,
  ContextToolCall,
  DerivedFacts,
  PriorVerdictItem,
  ReviewSnapshot,
  SessionKind,
} from './types.js';
import type { AgentLike, SessionsLike } from './snapshot/types.js';
import {
  checkpointEvents,
  sessionHumanEvents,
  relayEvents,
  mergeEvidence,
} from './snapshot/evidence.js';
import { truncateSnapshot } from './snapshot/budget.js';
export type {
  SessionEventLike,
  SessionLike,
  AgentLike,
  SessionsLike,
} from './snapshot/types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

async function readProjectRules(
  cwd: string,
  config: ArbiterConfig['context']['projectRules'],
): Promise<string | null> {
  if (!config.enabled) return null;
  for (const file of config.files) {
    try {
      const text = await readFile(join(cwd, file), 'utf8');
      return text.slice(0, 2_000);
    } catch {
      // Missing candidate is expected; try the next.
    }
  }
  return null;
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
  readonly priorVerdicts: readonly PriorVerdictItem[];
  readonly sessionRecordGap: string | null;
}

export interface BuiltSnapshot {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
}

function snapshotEvidence(options: SnapshotOptions) {
  const session = options.agent.session;
  const header = session.header ?? {};
  const parentSession = header.parentSession;
  const sessionKind: SessionKind =
    header.origin === 'subagent' || parentSession !== undefined
      ? 'subagent'
      : 'main';
  const sessionEvidence = sessionHumanEvents(session, 'session-human');
  const parent =
    parentSession === undefined
      ? undefined
      : options.sessions?.get?.(parentSession);
  const parentEvidence =
    parent === undefined ? [] : sessionHumanEvents(parent, 'parent-human');
  const parentAuthorizationPresent =
    parentSession === undefined ? null : parentEvidence.length > 0;
  const relay =
    parentSession === undefined ? [] : relayEvents(session, parentSession);
  const contextConfig = options.config.context;
  const merged = mergeEvidence(
    sessionEvidence,
    parentEvidence,
    relay,
    contextConfig.evidenceMaxItems,
    contextConfig.parentEvidenceFloor,
    contextConfig.parentHumanItems,
  );
  return {
    session,
    parentSession,
    sessionKind,
    sessionEvidence,
    parentEvidence,
    relay,
    parent,
    merged,
    parentAuthorizationPresent,
  };
}

function snapshotHistory(
  toolCalls: readonly ContextToolCall[],
  priorVerdicts: readonly PriorVerdictItem[],
  maxItems: number,
) {
  const combined = [
    ...toolCalls.map((call) => ({ kind: 'tool' as const, ts: call.ts, call })),
    ...priorVerdicts.map((verdict) => ({
      kind: 'verdict' as const,
      ts: verdict.ts,
      verdict,
    })),
  ]
    .sort((left, right) => right.ts - left.ts)
    .slice(0, maxItems);
  const selectedCalls = combined.flatMap((entry) =>
    entry.kind === 'tool' ? [entry.call] : [],
  );
  const selectedVerdicts = combined.flatMap((entry) =>
    entry.kind === 'verdict' ? [entry.verdict] : [],
  );
  const historyTruncated =
    combined.length < toolCalls.length + priorVerdicts.length;

  return { selectedCalls, selectedVerdicts, historyTruncated };
}

function missingEvidence(
  evidence: ReturnType<typeof snapshotEvidence>,
  sessionRecordGap: string | null,
): string[] {
  const { sessionEvidence, parentEvidence, relay, parentSession, parent } =
    evidence;
  const missing: string[] = [];
  if (
    sessionEvidence.length === 0 &&
    parentEvidence.length === 0 &&
    relay.length === 0
  ) {
    missing.push('no human authorization evidence is readable in this session');
  }
  if (
    [...sessionEvidence, ...parentEvidence, ...relay].some(
      (item) => item.truncated === true,
    )
  ) {
    missing.push(
      'one or more authorization evidence messages were truncated; their trailing content is not available',
    );
  }
  if (parentSession !== undefined && parent === undefined) {
    missing.push(
      'parent session is not live; parent human evidence is unavailable',
    );
  }
  if (sessionRecordGap !== null) missing.push(sessionRecordGap);

  return missing;
}

/** Build the immutable snapshot, prompt text and token estimate for one review. */
export async function buildReviewSnapshot(
  options: SnapshotOptions,
): Promise<BuiltSnapshot> {
  const evidence = snapshotEvidence(options);
  const {
    session,
    parentSession,
    sessionKind,
    merged,
    parentAuthorizationPresent,
  } = evidence;
  const contextConfig = options.config.context;
  const { checkpoints, toolCalls } = checkpointEvents(
    session,
    contextConfig.checkpointMaxItems,
    contextConfig.toolCallArgumentMaxChars,
    options.callId,
  );
  const { selectedCalls, selectedVerdicts, historyTruncated } = snapshotHistory(
    toolCalls,
    options.priorVerdicts,
    contextConfig.historyMaxItems,
  );

  const projectRules = await readProjectRules(
    options.cwd,
    contextConfig.projectRules,
  );
  const missing = missingEvidence(evidence, options.sessionRecordGap);

  const facts: DerivedFacts | null =
    options.facts === null
      ? null
      : {
          ...options.facts,
          parentAuthorizationPresent,
          historyTruncated: historyTruncated || options.facts.historyTruncated,
          overlapsDeniedEffect: options.facts.overlapsDeniedEffect,
        };

  const base: Omit<ReviewSnapshot, 'budget'> = {
    version: 1,
    createdAt: Date.now(),
    callId: options.callId,
    sessionId: session.id ?? 'unknown',
    sessionKind,
    ...(parentSession === undefined ? {} : { parentSessionId: parentSession }),
    tool: options.tool,
    cwd: options.cwd,
    action: {
      name: options.tool,
      arguments: options.arguments,
      ...(isRecord(options.arguments) &&
      typeof options.arguments['program'] === 'string'
        ? { programText: options.arguments['program'] }
        : {}),
    },
    facts,
    ...(options.hint === undefined ? {} : { hint: options.hint }),
    projectRules,
    customRules: contextConfig.customRules.slice(0, 2_000),
    evidence: merged.evidence,
    evidenceTruncated: merged.truncated,
    parentAuthorizationPresent,
    context: selectedCalls,
    checkpoints,
    contextTruncated: historyTruncated,
    priorVerdicts: selectedVerdicts,
    historyTruncated,
    missing,
  };
  const truncated = truncateSnapshot(base, contextConfig.maxInputTokens);
  return {
    snapshot: truncated.snapshot,
    system: truncated.system,
    user: truncated.user,
    estimatedInputTokens: truncated.snapshot.budget.estimatedInputTokens,
  };
}
