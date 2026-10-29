import { fingerprintOf, type CallRecord } from '../audit.js';
import { appendRecord } from '../records.js';
import type {
  CallResult,
  PreToolDecision,
  PriorVerdictItem,
  TraceStage,
} from '../types.js';
import {
  DECISION_RECORD,
  decisionPayload,
  isPriorVerdictCandidate,
} from './history-record.js';
import { deny, executionModeName, isAborted } from './common.js';
import { decisionFeedback } from './feedback.js';
import type { DecisionHistory } from './history.js';
import type { CallContext as CallContextType } from './types.js';
import type { AuditExtras, CallContext, HostEnvironment } from './types.js';

interface HumanOutcome {
  readonly result: CallResult;
  readonly stage: 'human' | 'fallback';
  readonly reason: string;
  readonly text: string;
}

/**
 * The single mapping from a host approval answer to a settled outcome.
 *
 * `unavailable` is a *fallback*, not a human answer: no one was asked, so it
 * must never be reported as a rejection. `cancelled` means the question ended
 * without an answer, which is an abort rather than a denial.
 */
const HUMAN_OUTCOMES = {
  'allowed-once': {
    result: 'human-allow',
    stage: 'human',
    reason: 'human_approved',
  },
  rejected: {
    result: 'human-deny',
    stage: 'human',
    reason: 'human_rejected',
  },
  cancelled: {
    result: 'human-abort',
    stage: 'human',
    reason: 'approval_cancelled',
  },
  unavailable: {
    result: 'fallback-deny',
    stage: 'fallback',
    reason: 'approval_unavailable',
  },
} satisfies Record<string, Omit<HumanOutcome, 'text'>>;

/**
 * The agent-facing text for one human or fallback ending.
 *
 * It goes through the same composer the rule and review paths use, so the rule,
 * the review reason and the snapshot's missing/truncated facts reach the agent
 * on every blocked outcome — not only on the two paths that deny directly.
 */
function humanText(
  extras: AuditExtras,
  result: CallResult,
  outcomeReason: string,
): string {
  return decisionFeedback({
    result,
    outcomeReason,
    ruleId: extras.ruleId,
    decisionRules: extras.decisionRules,
    reviewReason: extras.reviewReason,
    snapshot: extras.snapshot,
  });
}

/**
 * Whether a real person can be reached for this call.
 *
 * This is a fact about the host, not a policy, and it is decided once per call by
 * the gate and then carried here. Three conditions make a question impossible and
 * they are distinct reasons: a subagent has no channel of its own, a host may
 * expose no approval service, and a session's own approval policy may already
 * refuse prompts. None of them is a human answer.
 */
export interface AskChannel {
  readonly available: boolean;
  /**
   * Why no person can be asked.
   *
   * A stable code, because the record and the agent-facing text localize it; the
   * four cases above are different facts and collapsing them would lose which one
   * applied. `null` only when the channel is available.
   */
  readonly unavailableCode: UnavailableCode | null;
  /** The agent-facing sentence for the same reason. */
  readonly unavailableText: string | null;
}

/** The code each unavailable case records. */
type UnavailableCode =
  | 'automatic_mode_no_human'
  | 'subagent_no_human_channel'
  | 'approval_channel_unavailable'
  | 'host_approval_policy_never';

/** The sentence each unavailable code reports to the agent. */
const UNAVAILABLE_TEXT: Readonly<Record<UnavailableCode, string>> = {
  automatic_mode_no_human:
    'Not executed [fallback-deny]: this call requires human approval, but the selected mode does not open approval requests.',
  subagent_no_human_channel:
    'Not executed [fallback-deny]: this subagent has no human approval channel.',
  approval_channel_unavailable:
    'Not executed [fallback-deny]: no human approval channel is available.',
  host_approval_policy_never:
    'Not executed [fallback-deny]: the host approval policy rejects prompts in this session.',
};

/** The channel verdict for one call, from the mode and the host's own services. */
function channelOf(
  call: CallContext,
  host: HostEnvironment,
  approvalOpen: boolean,
): AskChannel {
  // An approval that is already on screen keeps waiting: switching to `no-ask`
  // must not withdraw a question the user is looking at. Only a decision that has
  // not been asked yet consults the currently effective mode.
  if (approvalOpen)
    return { available: true, unavailableCode: null, unavailableText: null };
  const unavailable = (code: UnavailableCode): AskChannel => ({
    available: false,
    unavailableCode: code,
    unavailableText: UNAVAILABLE_TEXT[code],
  });
  if (call.mode !== 'ask') return unavailable('automatic_mode_no_human');
  if (call.sessionKind !== 'main')
    return unavailable('subagent_no_human_channel');
  const approval = host.services.approval;
  if (approval === undefined)
    return unavailable('approval_channel_unavailable');
  const policy =
    approval.overrideOf?.(call.session) ?? approval.config?.policy ?? 'ask';
  return policy === 'never'
    ? unavailable('host_approval_policy_never')
    : { available: true, unavailableCode: null, unavailableText: null };
}

/** How many session-record failures stay addressable for diagnostics. */
const MAX_SESSION_RECORD_ERRORS = 200;

/**
 * How long an approved call may wait for a result before its entry is reaped.
 *
 * `tools/result` is expected for every allowed call, but a cancelled or
 * abandoned call may never produce one. The entry is dropped after this window
 * and the stored row keeps `pending` — the record must say "unknown outcome",
 * not invent success or failure.
 */
const PENDING_TTL_MS = 30 * 60 * 1000;

/** How many unresolved entries may accumulate before the oldest are reaped. */
const MAX_PENDING = 512;

/**
 * How many settled outcomes stay addressable.
 *
 * A settlement is one-shot, so an entry is only needed while a competing
 * continuation for the same call could still arrive — at most one turn. Keeping
 * a bounded tail preserves that guarantee without growing with every call the
 * plugin ever handled.
 */
const MAX_SETTLED_OUTCOMES = 512;

/** Drop entries that are stale or beyond the cap; unknown outcomes stay unknown. */
function reapPending(pending: HostEnvironment['runtime']['pending']): void {
  const cutoff = Date.now() - PENDING_TTL_MS;
  for (const [callId, entry] of pending) {
    if (entry.ts < cutoff) pending.delete(callId);
  }
  while (pending.size > MAX_PENDING) {
    const oldest = pending.keys().next().value;
    if (oldest === undefined) break;
    pending.delete(oldest);
  }
}

/**
 * Append a settlement stage with the configuration identity in force now.
 *
 * Human and fallback stages happen after the review stages, and a configuration
 * switch can land in between; each stage therefore records its own revision and
 * snapshot instead of inheriting the call's final values.
 */
interface StageIdentity {
  readonly configRevision: string;
  readonly configSnapshotId: string;
}

/** The configuration in force right now. */
function currentIdentity(host: HostEnvironment): StageIdentity {
  return {
    configRevision: host.runtime.effectiveRevision,
    configSnapshotId: host.runtime.configSnapshotId,
  };
}

function pushStage(
  trace: TraceStage[],
  stage: 'human' | 'fallback' | 'review',
  result: string,
  reason: string,
  identity: StageIdentity,
): void {
  trace.push({
    stage,
    result,
    reason,
    configRevision: identity.configRevision,
    configSnapshotId: identity.configSnapshotId,
    at: Date.now(),
  });
}

/** Settles decisions independently of best-effort audit persistence. */
/** The disposition a settled outcome hands back to the host. */
export type SettledDisposition = 'allow' | 'deny' | 'cancel';

/** One call's terminal outcome, claimed exactly once. */
export interface SettledOutcome {
  readonly result: CallResult;
  readonly disposition: SettledDisposition;
  readonly text: string;
}

const TERMINAL_DISPOSITIONS: Readonly<Record<string, SettledDisposition>> = {
  allow: 'allow',
  'review-allow': 'allow',
  'human-allow': 'allow',
  // A cancelled call is cancelled, not denied: the host must see the same
  // disposition it would have seen had the call never reached the reviewer.
  'review-cancelled': 'cancel',
};

/** The host answer a previously settled outcome dictates. */
function dispositionOf(outcome: SettledOutcome): PreToolDecision {
  if (outcome.disposition === 'allow') return { kind: 'allow' };
  if (outcome.disposition === 'cancel') return { kind: 'cancel' };
  return deny(outcome.text);
}

/** What the caller knows about the human question before asking it. */
export interface HumanAsk {
  /**
   * True when an approval is already outstanding for this call.
   *
   * A review that escalated before a configuration change has already put a
   * question on screen. Switching to `strict` afterwards must not withdraw it,
   * so the mode and channel are not re-evaluated; the user's answer still
   * settles the call. A decision that has not asked yet passes `false` and
   * consults the currently effective mode.
   */
  readonly approvalOpen?: boolean;
}

export class CallSettlement {
  private readonly host: HostEnvironment;
  private readonly history: DecisionHistory;
  /**
   * The one terminal outcome per call.
   *
   * A review and a human answer, an answer and a close, or two failures can all
   * reach for the same call's ending. The first claim wins; every later claim
   * gets the winner back instead of appending a second terminal stage or
   * returning a different disposition to the host.
   */
  private readonly outcomes = new Map<string, SettledOutcome>();
  constructor(host: HostEnvironment, history: DecisionHistory) {
    this.host = host;
    this.history = history;
  }

  /**
   * Whether this call already reached its final outcome.
   *
   * Settlement is one-shot: two paths can observe the same ending (an answer
   * and a close, a review and a cancel), and a second write would both corrupt
   * the audit chain and re-run the denial bookkeeping.
   */
  isSettled(callId: string): boolean {
    return this.outcomes.has(callId);
  }

  /** The outcome that already won this call, if any. */
  settledOutcome(callId: string): SettledOutcome | undefined {
    return this.outcomes.get(callId);
  }

  /** How many settled outcomes are still addressable; used to assert the bound. */
  settledOutcomeCount(): number {
    return this.outcomes.size;
  }

  /**
   * Write the session record and record what happened.
   *
   * Returns the write state so the audit row can carry it. A failure is both a
   * diagnostic entry and a history gap: the verdict exists in memory and cannot be
   * recovered from the log, which the next review must be told.
   */
  private writeRecord(
    session: CallContextType['session'],
    callId: string,
    prior: PriorVerdictItem,
  ): CallRecord['sessionRecordState'] {
    const { runtime } = this.host;
    const state = appendRecord(
      session,
      DECISION_RECORD,
      decisionPayload(prior),
    );
    const sessionId = session.id ?? 'unknown';
    if (state === 'written') {
      this.history.clearRecordFailure(sessionId);
      return state;
    }
    runtime.sessionRecordErrors.set(callId, state);
    // The map is diagnostic state, not history: keep the newest entries so a
    // session with a persistent write failure cannot grow it without bound.
    while (runtime.sessionRecordErrors.size > MAX_SESSION_RECORD_ERRORS) {
      const oldest = runtime.sessionRecordErrors.keys().next().value;
      if (oldest === undefined) break;
      runtime.sessionRecordErrors.delete(oldest);
    }
    this.history.noteRecordFailure(sessionId, state);
    return state;
  }

  private createRecord(
    call: CallContext,
    result: CallResult,
    reason: string,
    extras: AuditExtras,
  ): CallRecord {
    const { runtime, ctx } = this.host;
    const { exec, session, cwd } = call;
    const fingerprint = fingerprintOf(exec.name, exec.arguments);
    // One canonical time for this logical verdict. Memory, the session payload
    // and the audit row all carry this same value, so a restart cannot reorder
    // the window by observing three different clocks.
    const ts = Date.now();
    const prior: PriorVerdictItem = {
      ts,
      callId: exec.callId,
      configRevision: runtime.effectiveRevision,
      tool: exec.name,
      fingerprint,
      trace: call.trace.map((stage) => stage.result),
      result,
      reason,
      ...(extras.ruleId === null ? {} : { ruleId: extras.ruleId }),
      decisionRules: extras.decisionRules,
    };
    // Memory is updated first and independently, before either durable sink is
    // asked to accept anything. Runtime history must not wait for persistence:
    // a store that is slow, full or failing must not delay or lose the verdict
    // the next review needs.
    if (isPriorVerdictCandidate(result)) {
      this.history.rememberPrior(session.id ?? 'unknown', prior);
    }
    // One write, through the only public writer: the record carries every field
    // the runtime window keeps, so a cold reader does not have to reconstruct a
    // decision from a summary of it.
    const sessionRecordState = this.writeRecord(session, exec.callId, prior);
    return {
      callId: exec.callId,
      ts,
      sessionId: session.id ?? 'unknown',
      sessionKind: call.sessionKind,
      parentSession: session.header?.parentSession ?? null,
      profile: ctx.get('profileContext')?.name ?? null,
      workspace: cwd,
      tool: exec.name,
      arguments: exec.arguments,
      // The schema the host exposed for this call, kept as evidence; absent
      // means the host declared none, which the reader reports as null.
      ...(exec.schema === undefined ? {} : { argumentsSchema: exec.schema }),
      cwd,
      fingerprint,
      configRevision: runtime.effectiveRevision,
      configSnapshotId: runtime.configSnapshotId,
      approvalMode: call.mode,
      executionMode: executionModeName(ctx),
      result,
      reason,
      trace: call.trace,
      effect: extras.effect,
      sessionRecordState,
      snapshot: extras.snapshot,
      modelAttempts: extras.modelAttempts,
      // A current record carries the review's own semantics and nothing from the
      // retired engine: the two public bands plus their trails, the stage the
      // review reached, its reason and its usage summary. No thresholds, no probe
      // booleans and no strategy name, because none of them decides anything now.
      scores: extras.scores,
      reviewStage: extras.reviewStage,
      usage: extras.usage,
      decisionRules: extras.decisionRules,
      // A permission verdict is not an execution result: an approved call is
      // `pending` until the host reports what happened, and a denied one never
      // started. `executionStartedAt`/`FinishedAt` stay absent until then.
      executionStatus: ['allow', 'review-allow', 'human-allow'].includes(result)
        ? 'pending'
        : 'not-started',
      executionStartedAt: null,
      executionFinishedAt: null,
    };
  }

  /**
   * Claim the terminal outcome for this call, without writing anything yet.
   *
   * Claiming first is what makes the ending one-shot: the winner appends its
   * terminal stage and writes the record, while a competing path learns it lost
   * before it mutates the trace. The claim is released only if the write throws,
   * so a genuine failure can still be retried by the caller's own path.
   */
  claim(
    call: CallContext,
    result: CallResult,
    reason: string,
  ): { readonly won: boolean; readonly outcome: SettledOutcome } {
    const existing = this.outcomes.get(call.exec.callId);
    if (existing !== undefined) return { won: false, outcome: existing };
    const outcome: SettledOutcome = {
      result,
      disposition: TERMINAL_DISPOSITIONS[result] ?? 'deny',
      text: reason,
    };
    this.outcomes.set(call.exec.callId, outcome);
    // The winner still owes the record; only a completed write clears this.
    this.unwritten.add(call.exec.callId);
    // Keep the map bounded. Every entry exists so a competing continuation can
    // find the winner; once enough later calls have settled, an older entry can
    // no longer be reached by one, so the oldest are dropped exactly like the
    // pending-call map.
    while (this.outcomes.size > MAX_SETTLED_OUTCOMES) {
      const oldest = this.outcomes.keys().next().value;
      if (oldest === undefined) break;
      if (oldest === call.exec.callId) break;
      this.outcomes.delete(oldest);
      this.unwritten.delete(oldest);
    }
    return { won: true, outcome };
  }

  /**
   * Claim for this path, remembering that the winner still has to write.
   *
   * `claim()` alone cannot tell "I won and owe a write" from "someone else
   * already wrote"; the pending-write set carries that distinction so a path
   * that claimed before appending its terminal stage is not mistaken for a
   * duplicate.
   */
  private readonly unwritten = new Set<string>();

  /**
   * Write the outcome this path already claimed, or claim it now.
   *
   * A caller that appended its terminal stage only after winning must pass the
   * same result so the write is not mistaken for a duplicate claim.
   */
  finalize(
    call: CallContext,
    result: CallResult,
    reason: string,
    extras: AuditExtras,
  ): SettledOutcome {
    const existing = this.outcomes.get(call.exec.callId);
    if (existing !== undefined && !this.unwritten.has(call.exec.callId)) {
      // This call's ending is already written; nothing to add.
      return existing;
    }
    const outcome = existing ?? this.claim(call, result, reason).outcome;
    this.unwritten.delete(call.exec.callId);
    const record = this.createRecord(call, result, reason, extras);
    this.host.currentAudit()?.enqueue(record);
    if (record.executionStatus === 'pending') {
      const pending = this.host.runtime.pending;
      pending.set(call.exec.callId, {
        sessionId: record.sessionId,
        ts: record.ts,
      });
      // Keep the map bounded even when results never arrive.
      reapPending(pending);
    }
    if (
      [
        'deny',
        'review-deny',
        'human-deny',
        'human-abort',
        'fallback-deny',
      ].includes(result)
    ) {
      this.history.noteDenial(record.sessionId);
      this.history.rememberPrior(record.sessionId, {
        ts: record.ts,
        callId: record.callId,
        configRevision: record.configRevision,
        tool: record.tool,
        fingerprint: record.fingerprint,
        trace: call.trace.map((stage) => stage.result),
        result,
        reason,
        ...(extras.ruleId === null ? {} : { ruleId: extras.ruleId }),
        decisionRules: extras.decisionRules,
      });
    } else if (result === 'review-allow' || result === 'human-allow') {
      this.history.resetBreaker(record.sessionId);
    }
    return outcome;
  }

  private fallback(
    call: CallContext,
    reason: string,
    extras: AuditExtras,
  ): PreToolDecision {
    // Claim first: a competing path may already own this call's ending, and the
    // trace must show one terminal stage, not two. A fallback decided now is
    // governed by the configuration now, so its stage carries the live identity.
    // The agent gets the rule, the review reason and the snapshot facts here too:
    // a fallback is a blocked outcome, not a bare channel error.
    const text = humanText(extras, 'fallback-deny', reason);
    const claim = this.claim(call, 'fallback-deny', text);
    if (!claim.won) return dispositionOf(claim.outcome);
    pushStage(
      call.trace,
      'fallback',
      'fallback-deny',
      reason,
      currentIdentity(this.host),
    );
    const settled = this.finalize(call, 'fallback-deny', text, extras);
    return dispositionOf(settled);
  }

  /**
   * Race the approval answer against the call's cancellation signal.
   *
   * Both are installed before either can fire: the abort listener is attached
   * first, so a cancellation that happens before the answer resolves is seen as
   * a cancellation even when the promise later resolves with a real answer. An
   * answer that resolves first settles as that answer; a cancellation observed
   * afterwards does not rewrite it. This is what makes the two orderings
   * distinct instead of both being judged by one late `signal.aborted` read.
   */
  private async awaitAnswer(
    call: CallContext,
    approval: NonNullable<HostEnvironment['services']['approval']>,
    reason: string,
  ): Promise<
    | { readonly kind: 'answer'; readonly outcome: keyof typeof HUMAN_OUTCOMES }
    | { readonly kind: 'cancelled' }
    | { readonly kind: 'error'; readonly message: string }
  > {
    return new Promise((resolve) => {
      let settled = false;
      // Set as soon as the host's promise resolves, before its continuation
      // runs: a cancellation observed after that point answers a question that
      // already had an answer, so it must not replace it.
      let answered = false;
      const finish = (
        value:
          | {
              readonly kind: 'answer';
              readonly outcome: keyof typeof HUMAN_OUTCOMES;
            }
          | { readonly kind: 'cancelled' }
          | { readonly kind: 'error'; readonly message: string },
      ): void => {
        if (settled) return;
        settled = true;
        call.exec.signal.removeEventListener('abort', onAbort);
        resolve(value);
      };
      // Attached before the request is issued so an immediate abort is caught.
      const onAbort = (): void => {
        if (answered) return;
        // Cancellation claims the ending immediately. A later answer must not
        // overtake it, because an approval that was withdrawn while the user
        // was still deciding cannot authorize anything — and a bare promise
        // cannot prove that it settled before this synchronous abort.
        finish({ kind: 'cancelled' });
      };
      if (isAborted(call.exec.signal)) {
        finish({ kind: 'cancelled' });
        return;
      }
      call.exec.signal.addEventListener('abort', onAbort, { once: true });
      // Issue the request only after the abort listener is installed, so a
      // cancellation that happens while it is being asked is still observed.
      let answer: Promise<keyof typeof HUMAN_OUTCOMES>;
      try {
        answer = approval.request({
          agent: call.agent,
          toolName: call.exec.name,
          callId: call.exec.callId,
          reason,
          displayReason: {
            en: 'Arbiter needs a human decision for this call. Approve it only if its action, target and scope are intended.',
            zh: 'Arbiter 需要人工决定此调用。仅当操作、目标与范围符合预期时才批准。',
          },
          signal: call.exec.signal,
        });
      } catch (error) {
        // A service that throws before returning a promise is a channel
        // failure, not an escaping exception: settle it as a fallback.
        finish({
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        });
        return;
      }
      answer.then(
        (outcome) => {
          answered = true;
          finish({ kind: 'answer', outcome });
        },
        (error: unknown) => {
          answered = true;
          finish({
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          });
        },
      );
    });
  }

  /**
   * Settle a call whose review was cancelled after at least one attempt.
   *
   * The attempt list and its usage are the evidence this exists for: a provider
   * call that was billed must remain inspectable even though the call itself
   * produced no decision. The trace keeps an explicit cancellation stage so the
   * chain cannot be read as a reviewer failure or a human refusal, and the host
   * still receives a cancellation.
   */
  cancelledReview(
    call: CallContext,
    reason: string,
    extras: AuditExtras,
  ): PreToolDecision {
    const text = decisionFeedback({
      result: 'review-cancelled',
      outcomeReason: reason,
      ruleId: extras.ruleId,
      decisionRules: extras.decisionRules,
      reviewReason: extras.reviewReason,
      snapshot: extras.snapshot,
    });
    pushStage(
      call.trace,
      'review',
      'review-cancelled',
      reason,
      currentIdentity(this.host),
    );
    const claim = this.claim(call, 'review-cancelled', text);
    if (!claim.won) return dispositionOf(claim.outcome);
    return dispositionOf(this.finalize(call, 'review-cancelled', text, extras));
  }

  /**
   * Settle a call as a fallback denial for a review-stage escalation.
   *
   * Two different facts reach the agent and the record, and collapsing them would
   * lose one: *why nobody could be asked* (no channel, a mode that never asks, a
   * host policy that refuses prompts) and *why the call escalated* (the review's
   * own reason, a material gap, a reviewer failure). The channel cause is the
   * stage's outcome reason; the review reason stays the review's.
   */
  fallbackDeny(
    call: CallContext,
    reviewReason: string,
    extras: AuditExtras,
    ruleId: string | null,
  ): PreToolDecision {
    const channel = channelOf(call, this.host, false);
    return this.fallback(
      call,
      channel.available
        ? 'approval_channel_unavailable'
        : (channel.unavailableCode ?? 'approval_channel_unavailable'),
      { ...extras, ruleId, reviewReason: extras.reviewReason ?? reviewReason },
    );
  }

  /**
   * The channel verdict for one call.
   *
   * Exposed because the gate decides rule and review settlements under the same
   * question, and two independent evaluations of "can a person be asked" is how
   * a rule path and a review path could disagree about the same call.
   */
  channel(call: CallContext): AskChannel {
    return channelOf(call, this.host, false);
  }

  /**
   * Ask a human, then settle exactly once.
   *
   * `approvalOpen` is false for a decision this call is about to ask about; the
   * currently effective mode decides whether asking is allowed at all. It is
   * true when the question is already outstanding — for example a review that
   * escalated before a configuration change — and then mode and channel are no
   * longer re-evaluated, so the user's answer still settles it.
   */
  async human(
    call: CallContext,
    reason: string,
    extras: AuditExtras,
    ask: HumanAsk = {},
  ): Promise<PreToolDecision> {
    const existing = this.outcomes.get(call.exec.callId);
    if (existing !== undefined) {
      // A competing path already settled this call; hand back its outcome
      // rather than writing a second record or a different disposition.
      return dispositionOf(existing);
    }
    if (isAborted(call.exec.signal)) return { kind: 'cancel' };
    const verdict = channelOf(call, this.host, ask.approvalOpen === true);
    if (!verdict.available)
      return this.fallback(
        call,
        verdict.unavailableCode ?? 'approval_channel_unavailable',
        extras,
      );
    const approval = this.host.services.approval;
    if (approval === undefined)
      return this.fallback(call, 'approval_channel_unavailable', extras);
    // The request is opened under this configuration. It may stay pending while
    // the configuration changes, and the approval answers the question that was
    // asked, so the resulting stage keeps this identity — not whatever is
    // effective when the user finally answers.
    const requestIdentity = currentIdentity(this.host);
    // The answer and the cancellation race for the same ending, so they are
    // resolved as competing events: whichever is first *definitively* observed
    // wins, instead of a later snapshot of `signal.aborted` overriding an answer
    // that had already arrived.
    const first = await this.awaitAnswer(call, approval, reason);
    if (first.kind === 'error')
      return this.fallback(call, `approval_error: ${first.message}`, extras);
    const cancelled = first.kind === 'cancelled';
    const mapped = cancelled
      ? HUMAN_OUTCOMES.cancelled
      : HUMAN_OUTCOMES[first.outcome];
    const stageReason = cancelled ? 'approval_cancelled' : mapped.reason;
    // Approval text comes from the same composer as every other outcome; the
    // composer has a positive branch for `human-allow`, so it never reads as a
    // blocked call.
    const text = humanText(extras, mapped.result, stageReason);
    const claim = this.claim(call, mapped.result, text);
    if (!claim.won) return dispositionOf(claim.outcome);
    // The question was asked under the configuration captured when it opened,
    // so its stage keeps that identity even after a later switch.
    pushStage(
      call.trace,
      mapped.stage,
      mapped.result,
      stageReason,
      requestIdentity,
    );
    const settled = this.finalize(call, mapped.result, text, extras);
    return dispositionOf(settled);
  }
}
