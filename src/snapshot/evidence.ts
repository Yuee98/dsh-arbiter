/**
 * Evidence extraction and source layering.
 *
 * Only host-identified original human input becomes human evidence: a user
 * message carrying an rpcId, or a real answer to an ask interaction (the
 * foreground tool result, or the timed `user-question-reply` message). A short
 * answer keeps the question it answered so its scope survives. Everything else
 * — tool text, file content, assistant prose, checkpoint summaries — is never
 * upgraded to human authorization.
 *
 * Human evidence is not scoped to the current turn. A permission or restriction
 * given three turns ago stays in force until something newer and applicable
 * conflicts with it, so each item records the turn it came from instead of being
 * filtered by it. What the current turn does own is the tool history; see
 * `window.ts`.
 */

import type { ContextCheckpoint, EvidenceItem } from '../types.js';
import type { SessionEventLike } from './types.js';
import type { SessionLog } from './log.js';

const EVIDENCE_TEXT_LIMIT = 4_000;
const CHECKPOINT_TEXT_LIMIT = 2_000;

/** Conflict priority of the evidence layers; lower wins. */
const SOURCE_PRIORITY = {
  'session-human': 1,
  'parent-human': 2,
  'parent-relay': 5,
} as const;

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

function eventTs(event: SessionEventLike): number {
  return typeof event.time === 'number' ? event.time : event.seq;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

interface AskedQuestion {
  readonly id: string;
  readonly question: string;
}

function askedQuestions(value: unknown): readonly AskedQuestion[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = entry['id'];
    const question = entry['question'];
    return typeof id === 'string' && typeof question === 'string'
      ? [{ id, question }]
      : [];
  });
}

interface AnswerValue {
  readonly id: string;
  readonly selected: readonly string[];
  readonly custom: string | null;
}

function answerValues(value: unknown): readonly AnswerValue[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const id = entry['id'];
    const selected = entry['selected'];
    if (typeof id !== 'string' || !Array.isArray(selected)) return [];
    const custom = entry['custom'];
    return [
      {
        id,
        selected: selected.filter(
          (label): label is string => typeof label === 'string',
        ),
        custom:
          typeof custom === 'string' && custom.trim().length > 0
            ? custom
            : null,
      },
    ];
  });
}

interface AnswerBatch {
  readonly callId: string | null;
  readonly questions: readonly AskedQuestion[];
  readonly answers: readonly AnswerValue[];
}

/** Accept only the host-shaped answer payload; anything else is not an answer. */
function answerBatch(value: unknown): AnswerBatch | null {
  if (!isRecord(value)) return null;
  const answers = answerValues(value['answers']);
  if (answers.length === 0) return null;
  const callId = value['callId'];
  return {
    callId: typeof callId === 'string' ? callId : null,
    questions: askedQuestions(value['questions']),
    answers,
  };
}

/** One answer's human-readable value; a skipped answer yields null. */
function answeredValue(answer: AnswerValue): string | null {
  const parts = [answer.selected.join(', '), answer.custom ?? ''].filter(
    (part) => part.length > 0,
  );
  const text = parts.join(': ');
  return text.trim().length === 0 ? null : text;
}

/**
 * Render one answer batch so the question or operation it answers travels with
 * it. A skipped question (empty selection, no custom text) grants nothing and is
 * omitted; it never becomes an empty "approval".
 */
function answerText(batch: AnswerBatch): string {
  const byId = new Map(batch.questions.map((item) => [item.id, item.question]));
  const lines: string[] = [];
  for (const answer of batch.answers) {
    const value = answeredValue(answer);
    if (value === null) continue;
    const question = byId.get(answer.id);
    lines.push(
      question === undefined
        ? `Answer (question text unavailable): ${value}`
        : `Question: ${question}\nAnswer: ${value}`,
    );
  }
  return lines.join('\n');
}

/** Ask question text per call, taken from the call itself. */
function askCalls(
  events: readonly SessionEventLike[],
): Map<string, readonly AskedQuestion[]> {
  const calls = new Map<string, readonly AskedQuestion[]>();
  for (const event of events) {
    if (event.type !== 'tool/call' || !isRecord(event.data)) continue;
    if (event.data['name'] !== 'ask_user_question') continue;
    const callId = event.data['callId'];
    if (typeof callId !== 'string') continue;
    const raw = event.data['arguments'];
    const parsed = typeof raw === 'string' ? parseJson(raw) : raw;
    calls.set(
      callId,
      isRecord(parsed) ? askedQuestions(parsed['questions']) : [],
    );
  }
  return calls;
}

interface AskAnswer {
  readonly ts: number;
  readonly callId: string | null;
  readonly text: string;
  readonly questions: readonly AskedQuestion[];
}

/** A foreground answer arrives as the ask tool's own result. */
function foregroundAnswer(
  event: SessionEventLike,
  calls: Map<string, readonly AskedQuestion[]>,
): AskAnswer | null {
  if (event.type !== 'tool/result' || !isRecord(event.data)) return null;
  const message = event.data['message'];
  if (!isRecord(message) || message['isError'] === true) return null;
  const source = message['source'];
  if (!isRecord(source) || source['kind'] !== 'tool') return null;
  const callId = source['callId'];
  if (typeof callId !== 'string') return null;
  const asked = calls.get(callId);
  // Only this call's own ask result carries a human answer; other tool output
  // never does, however it is worded.
  if (asked === undefined) return null;
  const batch = answerBatch(parseJson(messageText(message['content'])));
  if (batch === null) return null;
  const questions = batch.questions.length > 0 ? batch.questions : asked;
  return {
    ts: eventTs(event),
    callId,
    text: answerText({ ...batch, questions }),
    questions,
  };
}

/** A timed late answer arrives as a host-identified user-question-reply. */
function continuedAnswer(event: SessionEventLike): AskAnswer | null {
  if (event.type !== 'user/message' || !isRecord(event.data)) return null;
  const source = event.data['source'];
  if (!isRecord(source) || source['kind'] !== 'user-question-reply')
    return null;
  const raw = messageText(event.data['content']);
  const sourceCallId =
    typeof source['callId'] === 'string' ? source['callId'] : null;
  const batch = answerBatch(parseJson(raw));
  if (batch === null) {
    // The host identified a human reply but not its structured answer; keep the
    // original text rather than dropping a human message.
    return {
      ts: eventTs(event),
      callId: sourceCallId,
      text: raw,
      questions: [],
    };
  }
  return {
    ts: eventTs(event),
    callId: batch.callId ?? sourceCallId,
    text: answerText(batch),
    questions: batch.questions,
  };
}

/** The turn marker to record, or no field when the log named no turn. */
function turnField(turn: number | null): { readonly turn?: number } {
  return turn === null ? {} : { turn };
}

function evidenceItem(
  kind: 'session-human' | 'parent-human',
  sessionId: string,
  answer: AskAnswer,
  turn: number | null,
): EvidenceItem {
  const truncated = answer.text.length > EVIDENCE_TEXT_LIMIT;
  const question = answer.questions
    .map((item) => item.question)
    .join('\n')
    .slice(0, CHECKPOINT_TEXT_LIMIT);
  return {
    ts: answer.ts,
    source: { kind, sessionId },
    role: 'human-instruction',
    evidence: 'explicit',
    sourcePriority: SOURCE_PRIORITY[kind],
    text: truncated ? answer.text.slice(0, EVIDENCE_TEXT_LIMIT) : answer.text,
    ...turnField(turn),
    ...(question.length === 0 ? {} : { question }),
    ...(answer.callId === null ? {} : { askCallId: answer.callId }),
    ...(truncated
      ? { truncated: true, originalLength: answer.text.length }
      : {}),
  };
}

function originalHumanItem(
  kind: 'session-human' | 'parent-human',
  sessionId: string,
  ts: number,
  text: string,
  turn: number | null,
): EvidenceItem {
  const truncated = text.length > EVIDENCE_TEXT_LIMIT;
  return {
    ts,
    source: { kind, sessionId },
    role: 'human-instruction',
    evidence: 'explicit',
    sourcePriority: SOURCE_PRIORITY[kind],
    text: truncated ? text.slice(0, EVIDENCE_TEXT_LIMIT) : text,
    ...turnField(turn),
    ...(truncated ? { truncated: true, originalLength: text.length } : {}),
  };
}

const SHORT_ANSWER =
  /^\s*(?:同意|可以|好|行|是的|对|确认|批准|yes|yep|ok|okay|sure|approved?|go ahead|continue|do it)[\s。.!！,，]*$/iu;

function isShortAnswer(text: string): boolean {
  return SHORT_ANSWER.test(text);
}

/**
 * The nearest assistant question before a short human answer.
 *
 * A plain chat "同意" is only meaningful with the operation it answered, so the
 * preceding assistant question is attached as context. It stays context: the
 * assistant text is never evidence and never authorizes anything. The search
 * stops at a turn boundary too, because a question cannot survive into a later
 * turn in which other work happened.
 */
function precedingQuestion(
  events: readonly SessionEventLike[],
  index: number,
): string | null {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const event = events[cursor];
    if (event === undefined) return null;
    // Another user message or a compaction summary starts a separate exchange:
    // an answer after either cannot be attributed to a question beyond it.
    if (event.type === 'user/message') return null;
    // A turn boundary ends the exchange as well: the answer belongs to whatever
    // was asked inside the turn it was given in.
    if (event.type === 'turn/start' || event.type === 'turn/end') return null;
    // A tool exchange is a boundary too. An ask result may already carry the
    // human's answer, so a later "continue" must not be attributed to the
    // question that a completed ask already answered.
    if (event.type === 'tool/call' || event.type === 'tool/result') return null;
    if (event.type !== 'assistant/message' || !isRecord(event.data)) continue;
    const message = event.data['message'];
    if (!isRecord(message)) continue;
    const text = messageText(message['content']).trim();
    // Only the assistant turn that immediately precedes the answer can own it;
    // an intervening statement means the question is stale.
    return text.endsWith('?') || text.endsWith('？')
      ? text.slice(0, CHECKPOINT_TEXT_LIMIT)
      : null;
  }
  return null;
}

/**
 * Whether this source is the host's own original human input.
 *
 * The host has two human source shapes and both are genuine human input: a
 * `user-rpc` message carries `rpcId`, while the ACP prompt bridge creates a
 * plain `{ kind: 'user' }` message with no `rpcId`. Requiring `rpcId` would drop
 * real human instructions — including withdrawals — and would then report the
 * session as having no human evidence at all.
 *
 * What still separates human input from everything else is the host's own
 * classification, not a field guess: agent relays, tool output, compaction
 * summaries and every other source kind are excluded, so this cannot be spoofed
 * by text that merely claims to be the user.
 */
function isHumanSource(source: Record<string, unknown>): boolean {
  return source['kind'] === 'user';
}

/**
 * Original human messages plus real ask answers, oldest first.
 *
 * Turn attribution travels with every item so a consumer can tell a same-turn
 * instruction from an older standing one; neither is dropped here, because an
 * older restriction stays in force until something conflicts with it.
 */
export function humanEvidence(
  log: SessionLog,
  kind: 'session-human' | 'parent-human',
  sessionId: string,
): EvidenceItem[] {
  const events = log.own;
  const calls = askCalls(events);
  const out: EvidenceItem[] = [];
  events.forEach((event, index) => {
    if (event.type !== 'user/message' || !isRecord(event.data)) return;
    const source = event.data['source'];
    if (!isRecord(source)) return;
    // A question reply is rendered from its structured answer below, so its raw
    // JSON is not also copied in as a second item.
    if (!isHumanSource(source)) return;
    const text = messageText(event.data['content']);
    if (text.trim().length === 0) return;
    const turn = log.turnOf[index] ?? null;
    const item = originalHumanItem(kind, sessionId, eventTs(event), text, turn);
    // A bare "同意" keeps the operation it answered. The quoted question is
    // context only: it cannot authorize more than the human's own words, and
    // with no reliable question the answer stays unscoped rather than guessed.
    const question = isShortAnswer(text)
      ? precedingQuestion(events, index)
      : null;
    out.push(question === null ? item : { ...item, question });
  });
  const answered: EvidenceItem[] = [];
  events.forEach((event, index) => {
    const answer = foregroundAnswer(event, calls) ?? continuedAnswer(event);
    if (answer === null || answer.text.trim().length === 0) return;
    answered.push(
      evidenceItem(kind, sessionId, answer, log.turnOf[index] ?? null),
    );
  });
  return [...out, ...answered].sort((left, right) => left.ts - right.ts);
}

/** Direct-parent relay only; sibling and grandparent senders are excluded. */
export function relayEvents(
  log: SessionLog,
  parentSession: string,
): EvidenceItem[] {
  const out: EvidenceItem[] = [];
  log.own.forEach((event, index) => {
    if (event.type !== 'user/message' || !isRecord(event.data)) return;
    const source = event.data['source'];
    if (!isRecord(source)) return;
    if (
      source['kind'] !== 'agent-message' ||
      source['senderSessionId'] !== parentSession
    ) {
      return;
    }
    const text = messageText(event.data['content']);
    if (text.trim().length === 0) return;
    const truncated = text.length > EVIDENCE_TEXT_LIMIT;
    out.push({
      ts: eventTs(event),
      source: { kind: 'parent-relay', sessionId: parentSession },
      role: 'direct-parent-instruction',
      evidence: 'implied',
      sourcePriority: SOURCE_PRIORITY['parent-relay'],
      text: truncated ? text.slice(0, EVIDENCE_TEXT_LIMIT) : text,
      ...turnField(log.turnOf[index] ?? null),
      ...(truncated ? { truncated: true, originalLength: text.length } : {}),
    });
  });
  return out.sort((left, right) => left.ts - right.ts);
}

function checkpointOf(event: SessionEventLike): ContextCheckpoint | null {
  if (event.type !== 'user/message' || !isRecord(event.data)) return null;
  const source = event.data['source'];
  if (!isRecord(source) || source['kind'] !== 'compact-checkpoint') return null;
  const text = messageText(event.data['content']);
  if (text.trim().length === 0) return null;
  return {
    ts: eventTs(event),
    text: text.slice(0, CHECKPOINT_TEXT_LIMIT),
  };
}

/** Whether this session carries a compaction summary at all. */
export function compacted(log: SessionLog): boolean {
  return log.own.some((event) => checkpointOf(event) !== null);
}

/**
 * The newest `maxItems` compaction summaries.
 *
 * A summary is lossy context: it restores what the session was about and never
 * authorizes anything. It is kept because a long session would otherwise lose
 * every early fact, and it is capped because it is not the material being
 * reviewed.
 */
export function checkpointEvents(
  log: SessionLog,
  maxItems: number,
): readonly ContextCheckpoint[] {
  const checkpoints: ContextCheckpoint[] = [];
  for (const event of log.own) {
    const checkpoint = checkpointOf(event);
    if (checkpoint !== null) checkpoints.push(checkpoint);
  }
  checkpoints.sort((left, right) => left.ts - right.ts);
  // `slice(-0)` is `slice(0)`: a configured zero must select no checkpoints.
  return maxItems <= 0 ? [] : checkpoints.slice(-maxItems);
}

function newestFirst(items: readonly EvidenceItem[]): EvidenceItem[] {
  return [...items].sort((left, right) => right.ts - left.ts);
}

export interface EvidenceLimits {
  readonly maxItems: number;
  readonly parentHumanItems: number;
  readonly parentFloor: number;
}

/**
 * Select evidence by source layer, not by timestamp alone.
 *
 * The parent-human floor is reserved first so a chatty child cannot crowd the
 * parent's original words out. Remaining slots are filled in conflict-priority
 * order — this session's human input, then the parent's, then the relay — newest
 * first inside each layer. The selected set is then ordered by time for display;
 * that display order never overrides the source priority.
 *
 * Two items are *protected*: the newest human statement of this session and the
 * newest parent original. Inside one layer the newer instruction wins on the
 * point in conflict, so the withdrawal that reverses an earlier approval must
 * never be the item dropped — and neither must the parent original the child's
 * own chatter would crowd out first.
 *
 * Protection can exceed capacity. `evidenceMaxItems = 1` is a legal
 * configuration, and with two protected items one of them cannot be carried.
 * Dropping the protected item silently would let the review score a misleading
 * subset, so the conflict is reported through `protectedDropped` and the caller
 * turns it into a blocking gap: a legally configured capacity that cannot
 * represent the required originals is a critical loss, not an ordinary cut.
 */
/** A protected original that capacity could not carry, and where it came from. */
export interface ProtectedOriginal {
  readonly source: 'session-human' | 'parent-human';
  /** A short description of the instruction that was not submitted. */
  readonly reason: string;
}

/**
 * Classify a protected item by its own source layer.
 *
 * A relay is never protected, so this only has to separate this session's human
 * input from the direct parent's. The fallback keeps an unexpected kind from
 * being silently reported as this session's material.
 */
function originOf(item: EvidenceItem): ProtectedOriginal['source'] {
  return item.source.kind === 'parent-human' ? 'parent-human' : 'session-human';
}

function protectedDropOf(item: EvidenceItem): ProtectedOriginal {
  return {
    source: originOf(item),
    reason: `the newest ${originOf(item)} statement (${String(item.text.length)} characters) was excluded by the configured evidence capacity`,
  };
}

export interface EvidenceSelection {
  readonly evidence: EvidenceItem[];
  readonly truncated: boolean;
  /**
   * Protected items this capacity could not carry, with their real source.
   *
   * Non-empty only when protected items outnumber the available slots. It is
   * separate from `truncated` because an ordinary capacity cut is not a
   * material failure while losing a protected original is. The source travels
   * with each item so the report names the material actually absent instead of
   * borrowing this session's name for a parent original.
   */
  readonly protectedDropped: readonly ProtectedOriginal[];
}

export function mergeEvidence(
  sessionHuman: readonly EvidenceItem[],
  parentHuman: readonly EvidenceItem[],
  relay: readonly EvidenceItem[],
  limits: EvidenceLimits,
): EvidenceSelection {
  const maxItems = Math.max(1, limits.maxItems);
  // `slice(-0)` is `slice(0)`; a configured zero must mean zero, not "all".
  const parentLimit = Math.max(0, limits.parentHumanItems);
  const parentRecent = parentLimit === 0 ? [] : parentHuman.slice(-parentLimit);
  const newestSession = newestFirst(sessionHuman)[0];
  // The floor is what a child's own chatter would crowd out first, so it is
  // reserved rather than merely ranked. It never consumes this session's own
  // protected slot: both protected originals compete for capacity, and the
  // conflict is reported rather than resolved by silently preferring one.
  const floor = Math.max(0, limits.parentFloor);
  const reserved = floor === 0 ? [] : parentRecent.slice(-floor);
  // This session's own newest statement ranks first: conflict priority puts it
  // above the parent's, and a withdrawal it carries is exactly what AC3 says a
  // capacity cut must not delay. The parent originals follow.
  const protectedItems = [
    ...(newestSession === undefined ? [] : [newestSession]),
    ...reserved,
  ];
  const carried = protectedItems.slice(0, maxItems);
  const protectedDropped = protectedItems
    .slice(maxItems)
    .map((item) => protectedDropOf(item));
  const carriedSet = new Set(carried);
  const rest = [
    ...newestFirst(sessionHuman),
    ...newestFirst(parentRecent),
    ...newestFirst(relay),
  ].filter((item) => !carriedSet.has(item));
  const slots = Math.max(0, maxItems - carried.length);
  const selected = [...carried, ...rest.slice(0, slots)];
  selected.sort((left, right) => right.ts - left.ts);
  // Compare against the whole population, not only the pre-sliced candidates:
  // `parentHumanItems` itself can hide parent originals, and that loss must be
  // visible as incomplete evidence rather than a complete-looking stream.
  const considered = sessionHuman.length + parentHuman.length + relay.length;
  return {
    evidence: selected,
    truncated:
      selected.length < considered ||
      selected.some((item) => item.truncated === true),
    protectedDropped,
  };
}
