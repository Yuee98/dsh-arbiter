/**
 * Immutable review input construction.
 *
 * One snapshot is built per review and then reused for prompt rendering,
 * auditing and the detail view. It records selection, truncation and missing
 * sources rather than re-reading a moving session later.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { renderRequest, renderSystem, renderUser } from './reviewer.js';
import type {
  ArbiterConfig,
  ContextCheckpoint,
  ContextToolCall,
  DerivedFacts,
  EvidenceItem,
  PriorVerdictItem,
  ReviewSnapshot,
  SessionKind,
} from './types.js';

export interface SessionHeaderLike {
  readonly id?: string;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly origin?: string;
  readonly delegationDepth?: number;
}

export interface SessionEventLike {
  readonly seq: number;
  readonly type: string;
  readonly time?: number;
  readonly data?: unknown;
}

export interface SessionLike {
  readonly id?: string;
  readonly header?: SessionHeaderLike;
  snapshotEvents?(): readonly SessionEventLike[];
  deriveMessages?(): readonly unknown[];
  requestHeader?():
    | { readonly config: { readonly provider: string; readonly model: string } }
    | undefined;
  append?(type: string, data: unknown): unknown;
}

export interface AgentLike {
  readonly session: SessionLike;
}

export interface SessionsLike {
  get?(id: string): SessionLike | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .flatMap((block) => {
      if (!isRecord(block)) return [];
      return block['type'] === 'text' && typeof block['text'] === 'string'
        ? [block['text']]
        : [];
    })
    .join('\n');
}

function eventsOf(session: SessionLike): readonly SessionEventLike[] {
  if (typeof session.snapshotEvents === 'function') {
    try {
      return session.snapshotEvents();
    } catch {
      return [];
    }
  }
  return [];
}

function sessionHumanEvents(
  session: SessionLike,
  kind: 'session-human' | 'parent-human',
): EvidenceItem[] {
  const sessionId = session.id ?? 'unknown';
  const out: EvidenceItem[] = [];
  for (const event of eventsOf(session)) {
    if (event.type !== 'user/message' || !isRecord(event.data)) continue;
    const source = event.data['source'];
    if (!isRecord(source)) continue;
    const sourceKind = source['kind'];
    const isHuman =
      (sourceKind === 'user' && typeof source['rpcId'] === 'string') ||
      sourceKind === 'user-question-reply';
    if (!isHuman) continue;
    const text = messageText(event.data['content']);
    if (text.trim().length === 0) continue;
    const truncated = text.length > 4_000;
    out.push({
      ts: typeof event.time === 'number' ? event.time : event.seq,
      source: { kind, sessionId },
      role: 'human-instruction',
      evidence: 'explicit',
      text: truncated ? text.slice(0, 4_000) : text,
      ...(truncated ? { truncated: true, originalLength: text.length } : {}),
    });
  }
  return out;
}

function relayEvents(
  session: SessionLike,
  parentSession: string,
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  for (const event of eventsOf(session)) {
    if (event.type !== 'user/message' || !isRecord(event.data)) continue;
    const source = event.data['source'];
    if (!isRecord(source)) continue;
    if (
      source['kind'] !== 'agent-message' ||
      source['senderSessionId'] !== parentSession
    )
      continue;
    const text = messageText(event.data['content']);
    if (text.trim().length === 0) continue;
    out.push({
      ts: typeof event.time === 'number' ? event.time : event.seq,
      source: { kind: 'parent-relay', sessionId: parentSession },
      role: 'direct-parent-instruction',
      evidence: 'implied',
      text: text.slice(0, 4_000),
    });
  }
  return out;
}

function checkpointEvents(
  session: SessionLike,
  maxItems: number,
  argumentMaxChars: number,
  currentCallId: string,
): {
  readonly checkpoints: ContextCheckpoint[];
  readonly toolCalls: ContextToolCall[];
} {
  const checkpoints: ContextCheckpoint[] = [];
  const toolCalls: ContextToolCall[] = [];
  for (const event of eventsOf(session)) {
    if (event.type === 'user/message' && isRecord(event.data)) {
      const source = event.data['source'];
      if (isRecord(source) && source['kind'] === 'compact-checkpoint') {
        const text = messageText(event.data['content']);
        if (text.trim().length > 0) {
          checkpoints.push({
            ts: typeof event.time === 'number' ? event.time : event.seq,
            text: text.slice(0, 2_000),
          });
        }
      }
    }
    if (event.type === 'tool/call' && isRecord(event.data)) {
      if (event.data['callId'] === currentCallId) continue;
      const name = event.data['name'];
      const rawArguments = event.data['arguments'];
      if (typeof name !== 'string') continue;
      const text =
        typeof rawArguments === 'string'
          ? rawArguments
          : JSON.stringify(rawArguments ?? {});
      const truncated = text.length > argumentMaxChars;
      toolCalls.push({
        ts: typeof event.time === 'number' ? event.time : event.seq,
        tool: name,
        arguments: truncated ? `${text.slice(0, argumentMaxChars)}…` : text,
        ...(truncated ? { argumentsTruncated: true } : {}),
      });
    }
  }
  checkpoints.sort((left, right) => left.ts - right.ts);
  toolCalls.sort((left, right) => left.ts - right.ts);
  return {
    checkpoints: checkpoints.slice(-maxItems),
    toolCalls,
  };
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

function mergeEvidence(
  sessionEvidence: readonly EvidenceItem[],
  parentEvidence: readonly EvidenceItem[],
  relay: readonly EvidenceItem[],
  maxItems: number,
  parentFloor: number,
  parentHumanItems: number,
): { readonly evidence: EvidenceItem[]; readonly truncated: boolean } {
  const parentRecent = parentEvidence.slice(-parentHumanItems);
  const reserved = parentRecent.slice(-parentFloor);
  const rest = [
    ...sessionEvidence,
    ...relay,
    ...parentRecent.filter((item) => !reserved.includes(item)),
  ].sort((left, right) => right.ts - left.ts);
  const slots = Math.max(0, maxItems - reserved.length);
  const selected = [...reserved, ...rest.slice(0, slots)];
  selected.sort((left, right) => right.ts - left.ts);
  return {
    evidence: selected,
    truncated:
      selected.length <
        sessionEvidence.length + parentEvidence.length + relay.length ||
      selected.some((item) => item.truncated === true),
  };
}

function truncateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  maxInputTokens: number,
): {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
} {
  const truncatedSegments = new Set<string>();
  let evidence = [...base.evidence];
  let context = [...base.context];
  let prior = [...base.priorVerdicts];
  let projectRules = base.projectRules;
  let facts = base.facts;
  let evidenceTruncated = base.evidenceTruncated;
  let contextTruncated = base.contextTruncated;
  let historyTruncated = base.historyTruncated;
  const missing = new Set(base.missing);

  const build = (): ReviewSnapshot => ({
    ...base,
    missing: [...missing],
    evidence,
    context,
    checkpoints: base.checkpoints,
    priorVerdicts: prior,
    projectRules,
    facts,
    evidenceTruncated,
    contextTruncated,
    historyTruncated,
    budget: {
      maxInputTokens,
      estimatedInputTokens: 0,
      truncatedSegments: [...truncatedSegments],
    },
  });

  for (let guard = 0; guard < 500; guard += 1) {
    const candidate = build();
    const rendered = renderRequest(candidate);
    if (rendered.estimatedInputTokens <= maxInputTokens) {
      return {
        snapshot: {
          ...candidate,
          budget: {
            ...candidate.budget,
            estimatedInputTokens: rendered.estimatedInputTokens,
          },
        },
        system: renderSystem(candidate),
        user: renderUser(candidate),
      };
    }
    if (evidence.length > 1) {
      evidence = evidence.slice(0, -1);
      evidenceTruncated = true;
      truncatedSegments.add('EVIDENCE');
      missing.add('authorization evidence was truncated by the input budget');
      continue;
    }
    if (context.length > 0) {
      context = context.slice(0, -1);
      contextTruncated = true;
      truncatedSegments.add('CONTEXT');
      missing.add('prior tool-call context was truncated by the input budget');
      continue;
    }
    if (prior.length > 0) {
      prior = prior.slice(0, -1);
      historyTruncated = true;
      truncatedSegments.add('PRIOR_VERDICTS');
      missing.add('prior verdicts were truncated by the input budget');
      continue;
    }
    if (projectRules !== null) {
      projectRules = null;
      truncatedSegments.add('PROJECT_RULES');
      continue;
    }
    if (facts !== null) {
      facts = {
        ...facts,
        observed: {
          writes: [],
          networkCommands: [],
          credentialPaths: [],
          pipelineExec: [],
          substitutions: facts.observed.substitutions,
          subshells: facts.observed.subshells,
        },
        completeness:
          facts.completeness === 'complete' ? 'partial' : facts.completeness,
        truncated: true,
      };
      truncatedSegments.add('DERIVED_FACTS');
      continue;
    }
    // PENDING_ACTION and the fixed policy are never truncated.
    return {
      snapshot: {
        ...build(),
        budget: {
          maxInputTokens,
          estimatedInputTokens: renderRequest(build()).estimatedInputTokens,
          truncatedSegments: [...truncatedSegments, 'OVER_BUDGET'],
        },
      },
      system: renderSystem(build()),
      user: renderUser(build()),
    };
  }
  const final = build();
  const system = renderSystem(final);
  const user = renderUser(final);
  const estimated = renderRequest(final).estimatedInputTokens;
  const over = estimated > maxInputTokens;
  return {
    snapshot: {
      ...final,
      budget: {
        maxInputTokens,
        estimatedInputTokens: estimated,
        truncatedSegments: [
          ...new Set([
            ...final.budget.truncatedSegments,
            ...(over ? ['OVER_BUDGET'] : []),
          ]),
        ],
      },
    },
    system,
    user,
  };
}

export interface BuiltSnapshot {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
  readonly estimatedInputTokens: number;
}

/** Build the immutable snapshot, prompt text and token estimate for one review. */
export async function buildReviewSnapshot(
  options: SnapshotOptions,
): Promise<BuiltSnapshot> {
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
  const { checkpoints, toolCalls } = checkpointEvents(
    session,
    contextConfig.checkpointMaxItems,
    contextConfig.toolCallArgumentMaxChars,
    options.callId,
  );
  const combined = [
    ...toolCalls.map((call) => ({ kind: 'tool' as const, ts: call.ts, call })),
    ...options.priorVerdicts.map((verdict) => ({
      kind: 'verdict' as const,
      ts: verdict.ts,
      verdict,
    })),
  ]
    .sort((left, right) => right.ts - left.ts)
    .slice(0, contextConfig.historyMaxItems);
  const selectedCalls = combined.flatMap((entry) =>
    entry.kind === 'tool' ? [entry.call] : [],
  );
  const selectedVerdicts = combined.flatMap((entry) =>
    entry.kind === 'verdict' ? [entry.verdict] : [],
  );
  const historyTruncated =
    combined.length < toolCalls.length + options.priorVerdicts.length;

  const projectRules = await readProjectRules(
    options.cwd,
    contextConfig.projectRules,
  );
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
  if (options.sessionRecordGap !== null) missing.push(options.sessionRecordGap);

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
