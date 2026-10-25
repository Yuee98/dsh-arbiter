import type {
  ContextCheckpoint,
  ContextToolCall,
  EvidenceItem,
} from '../types.js';
import type { SessionLike, SessionEventLike } from './types.js';

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

export function sessionHumanEvents(
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

export function relayEvents(
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

function checkpointOf(event: SessionEventLike): ContextCheckpoint | null {
  if (event.type === 'user/message' && isRecord(event.data)) {
    const source = event.data['source'];
    if (isRecord(source) && source['kind'] === 'compact-checkpoint') {
      const text = messageText(event.data['content']);
      if (text.trim().length > 0) {
        return {
          ts: typeof event.time === 'number' ? event.time : event.seq,
          text: text.slice(0, 2_000),
        };
      }
    }
  }
  return null;
}

export function checkpointEvents(
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
    const checkpoint = checkpointOf(event);
    if (checkpoint !== null) checkpoints.push(checkpoint);
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

export function mergeEvidence(
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
