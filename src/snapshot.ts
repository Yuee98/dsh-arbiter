/**
 * Immutable review input construction.
 *
 * One snapshot is built per review and then reused for prompt rendering,
 * auditing and the detail view. It records selection, truncation and missing
 * sources rather than re-reading a moving session later. Truncation and missing
 * material are input facts: they never throw, never change the review chain and
 * never decide the outcome by themselves.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  ArbiterConfig,
  ContextToolCall,
  DerivedFacts,
  EvidenceItem,
  PriorVerdictItem,
  ReviewSnapshot,
  SessionKind,
  SnapshotMaterial,
} from './types.js';
import type { AgentLike, SessionLike, SessionsLike } from './snapshot/types.js';
import {
  checkpointEvents,
  compacted,
  humanEvidence,
  readable,
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

const PROJECT_RULES_LIMIT = 2_000;
const CUSTOM_RULES_LIMIT = 2_000;
/** The two guidance sources share this combined ceiling. */
const GUIDANCE_LIMIT = 3_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface ProjectRulesResult {
  readonly text: string | null;
  readonly material: SnapshotMaterial;
  readonly missing: string | null;
}

/**
 * Read the first present candidate file. A disabled switch prevents the read
 * entirely, so its absence is reported as switched off rather than missing.
 */
async function readProjectRules(
  cwd: string,
  config: ArbiterConfig['context']['projectRules'],
): Promise<ProjectRulesResult> {
  const first = config.files[0];
  if (!config.enabled) {
    return {
      text: null,
      material: {
        id: 'project-rules',
        enabled: false,
        present: false,
        chars: 0,
        limit: PROJECT_RULES_LIMIT,
        truncated: false,
      },
      missing: null,
    };
  }
  for (const file of config.files) {
    let text: string;
    try {
      text = await readFile(join(cwd, file), 'utf8');
    } catch {
      // Missing candidate is expected; try the next one.
      continue;
    }
    const truncated = text.length > PROJECT_RULES_LIMIT;
    return {
      text: truncated ? text.slice(0, PROJECT_RULES_LIMIT) : text,
      material: {
        id: 'project-rules',
        enabled: true,
        present: true,
        chars: truncated ? PROJECT_RULES_LIMIT : text.length,
        limit: PROJECT_RULES_LIMIT,
        truncated,
        path: file,
      },
      missing: null,
    };
  }
  return {
    text: null,
    material: {
      id: 'project-rules',
      enabled: true,
      present: false,
      chars: 0,
      limit: PROJECT_RULES_LIMIT,
      truncated: false,
      ...(first === undefined ? {} : { path: first }),
    },
    missing:
      'PROJECT_RULES is enabled but none of the configured files could be read',
  };
}

function customRulesMaterial(customRules: string): SnapshotMaterial {
  return {
    id: 'custom-rules',
    enabled: true,
    present: customRules.length > 0,
    chars: customRules.length,
    limit: CUSTOM_RULES_LIMIT,
    truncated: customRules.length > CUSTOM_RULES_LIMIT,
  };
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

/**
 * Three-state parent authorization presence.
 *
 * `true` and `false` are affirmative claims about the parent's human history,
 * so they require a live, readable, uncompacted history. Everything else — no
 * parent, an unreadable log, or a summary that may have replaced the originals —
 * is `null` (unknown), which the reviewer treats as "could not verify".
 */
function parentPresence(
  isMainSession: boolean,
  parent: SessionLike | undefined,
  readableParent: boolean,
  compactedParent: boolean,
  hasHumanEvidence: boolean,
): boolean | null {
  if (isMainSession || parent === undefined) return null;
  if (!readableParent) return null;
  if (hasHumanEvidence) return true;
  return compactedParent ? null : false;
}

interface EvidenceState {
  readonly session: SessionLike;
  readonly parentSession: string | undefined;
  readonly sessionKind: SessionKind;
  readonly sessionEvidence: readonly EvidenceItem[];
  readonly parentEvidence: readonly EvidenceItem[];
  readonly relay: readonly EvidenceItem[];
  readonly parent: SessionLike | undefined;
  readonly merged: {
    readonly evidence: EvidenceItem[];
    readonly truncated: boolean;
  };
  readonly parentAuthorizationPresent: boolean | null;
  readonly parentReadable: boolean;
  readonly compaction: boolean;
  readonly parentCompaction: boolean;
}

function snapshotEvidence(options: SnapshotOptions): EvidenceState {
  const session = options.agent.session;
  const header = session.header ?? {};
  const parentId = header.parentSession;
  const sessionKind: SessionKind =
    header.origin === 'subagent' || parentId !== undefined
      ? 'subagent'
      : 'main';
  const contextConfig = options.config.context;
  const parent =
    parentId === undefined ? undefined : options.sessions?.get?.(parentId);
  const sessionEvidence = humanEvidence(session, 'session-human');
  const parentEvidence =
    parent === undefined ? [] : humanEvidence(parent, 'parent-human');
  const parentReadable = parent === undefined ? false : readable(parent);
  const parentCompacted = parent === undefined ? false : compacted(parent);
  // Three states, not two. `true`/`false` are claims we can only make when the
  // parent's human history is fully readable; a missing object, an unreadable
  // log, or a compaction summary that may have replaced human messages means
  // the originals are unavailable — unknown, never "no human input".
  const parentAuthorizationPresent = parentPresence(
    parentId === undefined,
    parent,
    parentReadable,
    parentCompacted,
    parentEvidence.length > 0,
  );
  const relay = parentId === undefined ? [] : relayEvents(session, parentId);
  const merged = mergeEvidence(sessionEvidence, parentEvidence, relay, {
    maxItems: contextConfig.evidenceMaxItems,
    parentHumanItems: contextConfig.parentHumanItems,
    parentFloor: contextConfig.parentEvidenceFloor,
  });
  return {
    session,
    parentSession: parentId,
    sessionKind,
    sessionEvidence,
    parentEvidence,
    relay,
    parent,
    merged,
    parentAuthorizationPresent,
    parentReadable,
    compaction: compacted(session),
    parentCompaction: parentCompacted,
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
  evidence: EvidenceState,
  sessionRecordGap: string | null,
  projectRulesMissing: string | null,
): string[] {
  const {
    sessionEvidence,
    parentEvidence,
    relay,
    parentSession,
    parent,
    parentReadable,
    compaction,
    parentCompaction,
  } = evidence;
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
  } else if (parentSession !== undefined && !parentReadable) {
    missing.push(
      'parent session events could not be read; parent human evidence is unavailable',
    );
  }
  if (compaction) {
    missing.push(
      'this session was compacted; human messages from before the compaction summary may no longer be readable',
    );
  }
  if (parentCompaction) {
    missing.push(
      'the parent session was compacted; earlier parent human messages may no longer be readable',
    );
  }
  if (projectRulesMissing !== null) missing.push(projectRulesMissing);
  if (sessionRecordGap !== null) missing.push(sessionRecordGap);

  return missing;
}

/**
 * Compose the plugin-owned feedback hint for a truncated or incomplete
 * submission. It states an input fact and offers recovery options; it never
 * claims that truncation caused a decision. The decision layer (DECISION #12)
 * decides whether and where to append it.
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
  const missing = missingEvidence(
    evidence,
    options.sessionRecordGap,
    projectRules.missing,
  );

  const facts: DerivedFacts | null =
    options.facts === null
      ? null
      : {
          ...options.facts,
          parentAuthorizationPresent,
          historyTruncated: historyTruncated || options.facts.historyTruncated,
          overlapsDeniedEffect: options.facts.overlapsDeniedEffect,
        };

  // The two guidance sources share one 3,000-character ceiling, so CUSTOM_RULES
  // yields first (it is user-global) rather than letting both reach 4,000.
  const trimmedCustomRules = contextConfig.customRules.slice(
    0,
    CUSTOM_RULES_LIMIT,
  );
  const projectText = projectRules.text;
  const projectBudget =
    projectText === null
      ? null
      : projectText.slice(
          0,
          Math.max(0, GUIDANCE_LIMIT - trimmedCustomRules.length),
        );
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
    projectRules: projectBudget,
    customRules: trimmedCustomRules,
    materials: [
      projectRules.material,
      customRulesMaterial(contextConfig.customRules),
    ],
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
