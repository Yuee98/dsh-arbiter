import { fingerprintOf, type CallRecord } from '../audit.js';
import { appendRecord } from '../records.js';
import type { CallResult, PreToolDecision, TraceStage } from '../types.js';
import { deny, executionModeName, isAborted } from './common.js';
import type { DecisionHistory } from './history.js';
import type { AuditExtras, CallContext, HostEnvironment } from './types.js';

interface HumanOutcome {
  readonly result: CallResult;
  readonly stage: 'human' | 'fallback';
  readonly reason: string;
  readonly text: string;
}

const HUMAN_OUTCOMES = {
  'allowed-once': {
    result: 'human-allow',
    stage: 'human',
    reason: 'human_approved',
    text: 'Arbiter: the user approved this call.',
  },
  rejected: {
    result: 'human-deny',
    stage: 'human',
    reason: 'human_rejected',
    text: 'Not executed [human-deny]: the user rejected this call.',
  },
  cancelled: {
    result: 'human-abort',
    stage: 'human',
    reason: 'approval_cancelled',
    text: 'Not executed [human-abort]: the approval ended without a grant or denial.',
  },
  unavailable: {
    result: 'fallback-deny',
    stage: 'fallback',
    reason: 'approval_unavailable',
    text: 'Not executed [fallback-deny]: no approval answerer was available.',
  },
} satisfies Record<string, HumanOutcome>;

function humanUnavailable(
  call: CallContext,
  host: HostEnvironment,
): { code: string; text: string } | null {
  if (call.mode !== 'normal')
    return {
      code: 'automatic_mode_no_human',
      text: 'Not executed [fallback-deny]: this call requires human approval, but the selected mode does not open approval requests.',
    };
  if (call.sessionKind !== 'main')
    return {
      code: 'subagent_no_human_channel',
      text: 'Not executed [fallback-deny]: this subagent has no human approval channel.',
    };
  const approval = host.services.approval;
  if (approval === undefined)
    return {
      code: 'approval_channel_unavailable',
      text: 'Not executed [fallback-deny]: no human approval channel is available.',
    };
  const policy =
    approval.overrideOf?.(call.session) ?? approval.config?.policy ?? 'ask';
  return policy === 'never'
    ? {
        code: 'host_approval_policy_never',
        text: 'Not executed [fallback-deny]: the host approval policy rejects prompts in this session.',
      }
    : null;
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
function pushStage(
  host: HostEnvironment,
  trace: TraceStage[],
  stage: 'human' | 'fallback',
  result: string,
  reason: string,
): void {
  trace.push({
    stage,
    result,
    reason,
    configRevision: host.runtime.effectiveRevision,
    configSnapshotId: host.runtime.configSnapshotId,
    at: Date.now(),
  });
}

/** Settles decisions independently of best-effort audit persistence. */
export class CallSettlement {
  private readonly host: HostEnvironment;
  private readonly history: DecisionHistory;
  constructor(host: HostEnvironment, history: DecisionHistory) {
    this.host = host;
    this.history = history;
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
    const sessionRecordState = appendRecord(
      session,
      'plugin:arbiter/decision',
      {
        version: 1,
        callId: exec.callId,
        tool: exec.name,
        fingerprint,
        trace: call.trace.map((stage) => stage.result),
        result,
        reason,
        ruleId: extras.ruleId,
        decisionRules: extras.decisionRules,
        configRevision: runtime.effectiveRevision,
        effect: extras.effect,
        ts: Date.now(),
      },
    );
    if (sessionRecordState !== 'written') {
      runtime.sessionRecordErrors.set(exec.callId, sessionRecordState);
      // The map is diagnostic state, not history: keep the newest entries so a
      // session with a persistent write failure cannot grow it without bound.
      while (runtime.sessionRecordErrors.size > MAX_SESSION_RECORD_ERRORS) {
        const oldest = runtime.sessionRecordErrors.keys().next().value;
        if (oldest === undefined) break;
        runtime.sessionRecordErrors.delete(oldest);
      }
    }
    return {
      callId: exec.callId,
      ts: Date.now(),
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
      signals: extras.signals,
      policyStrategy: extras.strategy,
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

  finalize(
    call: CallContext,
    result: CallResult,
    reason: string,
    extras: AuditExtras,
  ): void {
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
  }

  private fallback(
    call: CallContext,
    reason: string,
    text: string,
    extras: AuditExtras,
  ): PreToolDecision {
    pushStage(this.host, call.trace, 'fallback', 'fallback-deny', reason);
    this.finalize(call, 'fallback-deny', text, extras);
    return deny(text);
  }

  async human(
    call: CallContext,
    reason: string,
    extras: AuditExtras,
  ): Promise<PreToolDecision> {
    if (isAborted(call.exec.signal)) return { kind: 'cancel' };
    const unavailable = humanUnavailable(call, this.host);
    if (unavailable !== null)
      return this.fallback(call, unavailable.code, unavailable.text, extras);
    // humanUnavailable checks the channel before this point.
    const approval = this.host.services.approval;
    if (approval === undefined)
      return this.fallback(
        call,
        'approval_channel_unavailable',
        'Not executed [fallback-deny]: no human approval channel is available.',
        extras,
      );
    let outcome: keyof typeof HUMAN_OUTCOMES;
    try {
      outcome = await approval.request({
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
      return this.fallback(
        call,
        `approval_error: ${error instanceof Error ? error.message : String(error)}`,
        'Not executed [fallback-deny]: the human approval channel failed.',
        extras,
      );
    }
    const mapped = HUMAN_OUTCOMES[outcome];
    pushStage(
      this.host,
      call.trace,
      mapped.stage,
      mapped.result,
      mapped.reason,
    );
    this.finalize(call, mapped.result, mapped.text, extras);
    return mapped.result === 'human-allow'
      ? { kind: 'allow' }
      : deny(mapped.text);
  }
}
