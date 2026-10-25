import { modeForSession } from '../config.js';
import {
  applyProbeOverrides,
  decideReview,
  reclassifySignals,
} from '../policy.js';
import {
  runChatReviewer,
  runDecisionReviewer,
  type LlmLike,
} from '../reviewer.js';
import { evaluateCall } from '../rules/match.js';
import {
  buildReviewSnapshot,
  type AgentLike,
  type BuiltSnapshot,
} from '../snapshot.js';
import type {
  PolicyThresholds,
  PreToolDecision,
  PriorVerdictItem,
} from '../types.js';
import { deny, isAborted, sessionKindOf } from './common.js';
import type { DecisionHistory } from './history.js';
import type { PermissionLifecycle } from './permissions.js';
import { releaseRuntime } from './runtime.js';
import type { CallSettlement } from './settlement.js';
import type {
  AuditExtras,
  CallContext,
  HostEnvironment,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

interface PreparedCall extends CallContext {
  readonly evaluation: ReturnType<typeof evaluateCall>;
  readonly prior: PriorVerdictItem[];
  readonly thresholds: PolicyThresholds;
  readonly extras: AuditExtras;
}

type ModelResult = Awaited<ReturnType<typeof runChatReviewer>>;

function modelReasonFor(decision: {
  readonly decisionRules: readonly string[];
}): string {
  const reasons: Record<string, string> = {
    R1: 'sensitive material would leave the machine',
    R2: 'critical risk of irreversible damage',
    R3: 'no sufficient authorization was found',
    R4: 'bulk irreversible destruction requires a human decision',
    R5: 'the risk exceeds the selected policy ceiling',
    R6: 'bulk external sending exceeds the selected policy ceiling',
    R8: 'the available signals are insufficient',
  };
  return (
    reasons[decision.decisionRules[0] ?? ''] ??
    'the review did not approve this action'
  );
}

/** Gate admission, rule evaluation and reviewer hand-off. */
export class CallGate {
  private readonly host: HostEnvironment;
  private readonly permissions: PermissionLifecycle;
  private readonly history: DecisionHistory;
  private readonly settlement: CallSettlement;
  constructor(
    host: HostEnvironment,
    permissions: PermissionLifecycle,
    history: DecisionHistory,
    settlement: CallSettlement,
  ) {
    this.host = host;
    this.permissions = permissions;
    this.history = history;
    this.settlement = settlement;
  }

  register(): void {
    this.host.ctx.on(
      'tools/pre-execute',
      (exec: ToolExecutionLike, next: () => Promise<PreToolDecision>) =>
        this.handle(exec, next),
      { prepend: true },
    );
    this.host.ctx.on(
      'tools/result',
      (exec: ToolExecutionLike, result: ToolResultLike) => {
        if (!this.host.runtime.pending.has(exec.callId)) return;
        this.host.runtime.pending.delete(exec.callId);
        this.host
          .currentAudit()
          ?.updateExecution(
            exec.callId,
            result.isError === true ? 'failed' : 'success',
          );
      },
    );
  }

  private async handle(
    exec: ToolExecutionLike,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const { runtime, lifecycle } = this.host;
    if (!runtime.config.enabled || !runtime.accepting) {
      lifecycle('gate/skipped', {
        callId: exec.callId,
        tool: exec.name,
        sessionId: exec.agent?.session.id ?? null,
        accepting: runtime.accepting,
      });
      return next();
    }
    if (isAborted(exec.signal)) return { kind: 'cancel' };
    const agent = exec.agent;
    // Declared coverage gap: no agent means no session/evidence/approval channel.
    if (agent === undefined) return next();
    runtime.active += 1;
    try {
      const sessionId = agent.session.id ?? 'unknown';
      this.permissions.managed.set(sessionId, agent.session);
      lifecycle('gate/entered', {
        callId: exec.callId,
        tool: exec.name,
        sessionId,
        active: runtime.active,
      });
      const call = await this.prepare(exec, agent);
      const ruleResult = await this.applyRule(call);
      return ruleResult ?? (await this.review(call));
    } finally {
      runtime.active -= 1;
      releaseRuntime(runtime);
    }
  }

  private async ensureCwd(
    agent: AgentLike,
    signal: AbortSignal,
  ): Promise<string> {
    if (this.host.services.workingDirectory !== undefined) {
      try {
        return await this.host.services.workingDirectory.ensure(agent, signal);
      } catch {
        /* Fall through to the session header. */
      }
    }
    return agent.session.header?.cwd ?? process.cwd();
  }

  private async prepare(
    exec: ToolExecutionLike,
    agent: AgentLike,
  ): Promise<PreparedCall> {
    const { runtime } = this.host;
    const session = agent.session;
    const sessionKind = sessionKindOf(agent);
    const mode = modeForSession(runtime.config, sessionKind);
    const strategy = mode === 'progress' ? 'progress' : 'normal';
    const thresholds =
      strategy === 'progress'
        ? runtime.config.policy.progress
        : runtime.config.policy.normal;
    let cwd = process.cwd();
    try {
      cwd = await this.ensureCwd(agent, exec.signal);
    } catch {
      /* Keep process cwd; the snapshot records the actual value. */
    }
    const prior = this.history.priorFor(session.id ?? 'unknown');
    const evaluation = evaluateCall({
      rules: runtime.config.rules.filter((rule) => rule.enabled !== false),
      tool: exec.name,
      arguments: exec.arguments,
      identity: sessionKind,
      workspaceRoot: cwd,
      cwd,
      parentAuthorizationPresent: null,
      historyTruncated: prior.length >= runtime.config.context.historyMaxItems,
      overlapsDeniedEffect: false,
    });
    const path = evaluation.path;
    return {
      exec,
      agent,
      session,
      sessionKind,
      mode,
      cwd,
      prior,
      evaluation,
      thresholds,
      trace: [
        {
          stage: 'rule',
          result: path.kind === 'rule' ? path.verdict : 'review(default)',
          ...(path.kind === 'rule' ? { ruleId: path.ruleId } : {}),
          ...(path.kind === 'review-default' ? { reason: path.reason } : {}),
          configRevision: runtime.effectiveRevision,
          at: Date.now(),
        },
      ],
      extras: {
        effect: evaluation.facts === null ? null : { ...evaluation.facts },
        signals: null,
        snapshot: null,
        strategy,
        decisionRules: [],
        modelAttempts: [],
        ruleId: path.kind === 'rule' ? path.ruleId : null,
      },
    };
  }

  private async applyRule(call: PreparedCall): Promise<PreToolDecision | null> {
    const path = call.evaluation.path;
    if (path.kind !== 'rule') return null;
    if (path.verdict === 'force-ask') {
      return this.settlement.human(
        call,
        'force-ask requires a human decision for this call.',
        call.extras,
      );
    }
    if (path.verdict === 'deny') {
      const reason =
        'Not executed [deny-rule]: a deny command rule matched this call.';
      this.settlement.finalize(call, 'deny', reason, call.extras);
      return deny(reason);
    }
    if (path.verdict === 'allow') {
      this.settlement.finalize(
        call,
        'allow',
        'Arbiter: a complete allow rule covered this call.',
        call.extras,
      );
      return { kind: 'allow' };
    }
    return null;
  }

  private async snapshot(
    call: PreparedCall,
  ): Promise<{ bundle: BuiltSnapshot; llm: LlmLike }> {
    const { runtime, services } = this.host;
    const llm = services.llm;
    if (llm === undefined) throw new Error('llm service is unavailable');
    const path = call.evaluation.path;
    const hint =
      path.kind === 'rule' && path.verdict === 'force-review'
        ? path.hint
        : undefined;
    const bundle = await buildReviewSnapshot({
      agent: call.agent,
      ...(services.sessions === undefined
        ? {}
        : { sessions: services.sessions }),
      tool: call.exec.name,
      arguments: call.exec.arguments,
      callId: call.exec.callId,
      cwd: call.cwd,
      config: runtime.config,
      facts: call.evaluation.facts,
      ...(hint === undefined ? {} : { hint }),
      priorVerdicts: call.prior,
      sessionRecordGap:
        runtime.sessionRecordErrors.get(call.exec.callId) ?? null,
    });
    return { bundle, llm };
  }

  private async review(call: PreparedCall): Promise<PreToolDecision> {
    if (this.history.breakerOpen(call.session.id ?? 'unknown')) {
      call.trace.push({
        stage: 'review',
        result: 'error-escalate',
        reason: 'circuit_open',
        at: Date.now(),
      });
      return this.settlement.human(
        call,
        'Review circuit breaker is open for this session.',
        call.extras,
      );
    }
    let snapshot: { bundle: BuiltSnapshot; llm: LlmLike };
    try {
      snapshot = await this.snapshot(call);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      call.trace.push({
        stage: 'review',
        result: 'error-escalate',
        reason: `snapshot_error: ${message}`,
        configRevision: this.host.runtime.effectiveRevision,
        at: Date.now(),
      });
      return this.settlement.human(call, message, call.extras);
    }
    if (
      snapshot.bundle.snapshot.budget.truncatedSegments.includes('OVER_BUDGET')
    ) {
      // A legal truncation is a normal review; a request that cannot be
      // assembled within the declared budget is a request-preparation failure,
      // not a decision. Recording it as error-escalate keeps the chain honest.
      const message =
        'the review request cannot be assembled within the configured input budget';
      call.trace.push({
        stage: 'review',
        result: 'error-escalate',
        reason: 'input_budget_exceeded',
        configRevision: this.host.runtime.effectiveRevision,
        at: Date.now(),
      });
      return this.settlement.human(call, message, {
        ...call.extras,
        snapshot: snapshot.bundle.snapshot,
      });
    }
    this.noteReview(call.session.id ?? 'unknown');
    const result = await this.requestModel(call, snapshot.bundle, snapshot.llm);
    if (isAborted(call.exec.signal)) return { kind: 'cancel' };
    return this.settleModel(call, snapshot.bundle, result);
  }

  private noteReview(sessionId: string): void {
    const { runtime, ctx } = this.host;
    const count = runtime.reviewCounts.get(sessionId) ?? 0;
    runtime.reviewCounts.set(sessionId, count + 1);
    if (
      runtime.config.reviewBudget !== null &&
      count + 1 === runtime.config.reviewBudget
    ) {
      ctx.logger.warn(
        'arbiter: review budget (%s) reached for this session; reviews continue (the budget is advisory)',
        String(runtime.config.reviewBudget),
      );
    }
  }

  private async requestModel(
    call: PreparedCall,
    bundle: BuiltSnapshot,
    llm: LlmLike,
  ): Promise<ModelResult> {
    const { runtime, lifecycle, services } = this.host;
    const thresholds = call.thresholds;
    if (runtime.config.reviewer.type === 'chat') {
      lifecycle('review/start', {
        callId: call.exec.callId,
        sessionId: call.session.id ?? 'unknown',
      });
      const result = await runChatReviewer(
        {
          llm,
          session: call.session,
          chat: runtime.config.reviewer.chat,
          thresholds,
          signal: call.exec.signal,
        },
        bundle.snapshot,
        bundle,
        call.exec.callId,
      );
      lifecycle(result.ok ? 'review/settled' : 'review/failed', {
        callId: call.exec.callId,
        sessionId: call.session.id ?? 'unknown',
      });
      return result;
    }
    return runDecisionReviewer(
      {
        fetch: globalThis.fetch,
        credentials: services.credentials,
        decision: runtime.config.reviewer.decision,
        thresholds,
        signal: call.exec.signal,
      },
      bundle.snapshot,
      { user: bundle.user, estimatedInputTokens: bundle.estimatedInputTokens },
      call.exec.callId,
    );
  }

  private async settleModel(
    call: PreparedCall,
    bundle: BuiltSnapshot,
    result: ModelResult,
  ): Promise<PreToolDecision> {
    const { runtime } = this.host;
    // Responses retain their original protocol; decisions use the policy now effective.
    const mode = modeForSession(runtime.config, call.sessionKind);
    const current = { ...call, mode };
    const strategy = mode === 'progress' ? 'progress' : 'normal';
    const thresholds =
      strategy === 'progress'
        ? runtime.config.policy.progress
        : runtime.config.policy.normal;
    const extras = {
      ...call.extras,
      snapshot: bundle.snapshot,
      strategy,
      modelAttempts: result.attempts,
    };
    if (!result.ok) {
      call.trace.push({
        stage: 'review',
        result: 'error-escalate',
        reason: result.error,
        configRevision: runtime.effectiveRevision,
        at: Date.now(),
      });
      return this.settlement.human(
        current,
        `review failed: ${result.error}`,
        extras,
      );
    }
    const signals = reclassifySignals(
      applyProbeOverrides(
        result.signals,
        call.evaluation.facts,
        runtime.config.policy.probeMode,
      ),
      thresholds,
    );
    const policy = decideReview(signals, strategy, thresholds);
    call.trace.push({
      stage: 'review',
      result: policy.verdict,
      reason: policy.reason,
      decisionRules: policy.decisionRules,
      configRevision: runtime.effectiveRevision,
      at: Date.now(),
    });
    const reviewedExtras = {
      ...extras,
      signals,
      decisionRules: policy.decisionRules,
    };
    if (policy.verdict === 'review-allow') {
      this.settlement.finalize(
        current,
        'review-allow',
        'Arbiter: the review allowed this call.',
        reviewedExtras,
      );
      return { kind: 'allow' };
    }
    if (policy.verdict === 'review-deny') {
      const text = `Not executed [review-deny]: ${modelReasonFor(policy)}.`;
      this.settlement.finalize(current, 'review-deny', text, reviewedExtras);
      return deny(text);
    }
    return this.settlement.human(
      current,
      `review requires a human decision: ${modelReasonFor(policy)}`,
      reviewedExtras,
    );
  }
}
