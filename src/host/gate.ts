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
import { modeForSession } from '../config.js';
import { stageView, type StageView } from './stage.js';
import { decisionFeedback } from './feedback.js';
import { evaluateCall } from '../rules/match.js';
import type { HistoryStatus } from '../types.js';
import {
  buildReviewSnapshot,
  type AgentLike,
  type BuiltSnapshot,
} from '../snapshot.js';
import type {
  AdmissionScopeReason,
  CommandRule,
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
  /** The exact rule list the evaluation indexed into. */
  readonly evaluatedRules: readonly CommandRule[];
  readonly prior: PriorVerdictItem[];
  /** The facts about `prior`, read at the same moment so they cannot disagree. */
  readonly historyStatus: HistoryStatus;
  /** The configuration this evaluation actually used, captured after the wait. */
  readonly view: StageView;
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

/** The trace field for a resolved historical rule name, or nothing. */
function ruleNameStage(name: string | null): { readonly ruleName?: string } {
  return name === null ? {} : { ruleName: name };
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
        // The pending map only holds approved-but-unfinished calls; a result for
        // a call that never entered it is not this map's business.
        if (!this.host.runtime.pending.has(exec.callId)) return;
        this.host.runtime.pending.delete(exec.callId);
        this.host
          .currentAudit()
          ?.updateExecution(
            exec.callId,
            result.isError === true ? 'failed' : 'success',
          );
        // A terminal result ends a pending entry; unresolved entries are reaped
        // by the bounded sweep so an observed-but-abandoned call cannot grow the
        // map without limit.
      },
    );
  }

  private async handle(
    exec: ToolExecutionLike,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> {
    const { runtime, lifecycle } = this.host;
    // A session whose teardown rollback could not be confirmed stays refused:
    // its wide sandbox is still in force, so handing the call back would run
    // it ungated under a boundary this plugin set.
    const refused = this.refuseUnconfirmed(exec);
    if (refused !== null) return refused;
    if (!runtime.config.enabled || !runtime.accepting) {
      // A session can become live after teardown or a startup reconcile ran —
      // for example a trusted session reopened later. This is the last moment
      // this plugin sees it, so narrow it here before the gate steps aside;
      // otherwise it would run ungated with the permission the plugin widened.
      const skipped = this.releaseBeforeBypass(exec);
      if (skipped !== null) return skipped;
      lifecycle('gate/skipped', {
        callId: exec.callId,
        tool: exec.name,
        sessionId: exec.agent?.session.id ?? null,
        accepting: runtime.accepting,
        reason: runtime.config.enabled ? 'not-accepting' : 'plugin-disabled',
      });
      return next();
    }
    if (isAborted(exec.signal)) return { kind: 'cancel' };
    const agent = exec.agent;
    // Declared coverage gap: no agent means no session/evidence/approval
    // channel, and no admission can be resolved for it.
    if (agent === undefined) {
      lifecycle('gate/skipped', {
        callId: exec.callId,
        tool: exec.name,
        sessionId: null,
        reason: 'no-agent',
      });
      return next();
    }
    // Admission is per session and comes from the session log. A missing or
    // disabled record, an unenabled parent, or an unresolvable parent chain
    // means this call is not this plugin's to decide.
    const scope = this.permissions.admissions.scopeFor(agent.session);
    if (!scope.managed) return this.skippedCall(exec, scope.reason, next);
    runtime.active += 1;
    try {
      const sessionId = agent.session.id ?? 'unknown';
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

  /**
   * Answer a call that admission does not cover.
   *
   * Almost every reason means "not this plugin's to decide", so the call is
   * handed back. The exception is a guarded session the host would not
   * confine: approving it would execute outside the workspace under a boundary
   * this plugin widened, so it is refused instead.
   */
  private skippedCall(
    exec: ToolExecutionLike,
    reason: AdmissionScopeReason,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> | PreToolDecision {
    if (reason === 'boundary-unconfirmed') {
      this.host.lifecycle('gate/refused', {
        callId: exec.callId,
        tool: exec.name,
        sessionId: exec.agent?.session.id ?? null,
        reason,
      });
      return deny(
        'Not executed [boundary-unconfirmed]: the guarded boundary could not be confirmed on this session, so this call is refused rather than approved under a wider host permission.',
      );
    }
    this.host.lifecycle('gate/skipped', {
      callId: exec.callId,
      tool: exec.name,
      sessionId: exec.agent?.session.id ?? null,
      reason,
    });
    return next();
  }

  /**
   * Narrow a late-arriving managed session before the gate stops deciding.
   *
   * The startup and configuration reconciles can only see sessions that are
   * live at that moment. A restored session opened afterwards is still admitted
   * by its log and may still hold a sandbox this plugin widened, so the first
   * call it makes is the last chance to take that permission back. Returns a
   * refusal when the boundary cannot be confirmed, otherwise `null` so the
   * ordinary bypass proceeds.
   */
  private releaseBeforeBypass(exec: ToolExecutionLike): PreToolDecision | null {
    const session = exec.agent?.session;
    if (session === undefined) return null;
    const narrowed = this.permissions.admissions.releaseOne(session);
    if (narrowed !== 'unsafe') return null;
    this.host.lifecycle('gate/refused', {
      callId: exec.callId,
      tool: exec.name,
      sessionId: session.id ?? null,
      reason: 'boundary-unconfirmed',
    });
    return deny(
      'Not executed [boundary-unconfirmed]: the plugin is disabled but this session could not be returned to a safe host permission, so this call is refused rather than run ungated.',
    );
  }

  /**
   * Refuse calls from a session whose rollback could not be confirmed.
   *
   * This is deliberately the narrowest possible gate: it runs before any other
   * admission decision, only matches sessions a failed rollback marked, and
   * never opens a review or a human request.
   *
   * The mark is a recheck trigger, not a permanent verdict. A host that refused
   * a write once (mid-publish, at startup) may accept it a moment later, and
   * the user may also have re-selected a safe permission by hand. So each call
   * retries the rollback: a confirmed boundary clears the mark and the call
   * continues, and only a still-unconfirmed session is refused. Keeping the
   * mark sticky would turn a transient failure into a session that nothing can
   * ever use again.
   */
  private refuseUnconfirmed(exec: ToolExecutionLike): PreToolDecision | null {
    const sessionId = exec.agent?.session.id;
    if (sessionId === undefined) return null;
    if (!this.permissions.admissions.isFailingClosed(sessionId)) return null;
    if (this.permissions.retryRollback(exec.agent?.session)) {
      this.host.lifecycle('gate/fail-closed-cleared', {
        callId: exec.callId,
        tool: exec.name,
        sessionId,
      });
      return null;
    }
    const reason =
      'Not executed [fallback-deny]: this session could not be rolled back to a safe permission during plugin teardown, and the host has not accepted the narrowing yet.';
    this.host.lifecycle('gate/fail-closed', {
      callId: exec.callId,
      tool: exec.name,
      sessionId,
    });
    return deny(reason);
  }

  /**
   * The call as it stands when a human question is about to be asked.
   *
   * Nothing has been shown yet, so eligibility belongs to the configuration
   * effective now — not to the mode captured before the snapshot took time. An
   * approval that is already on screen is a different path: it keeps waiting
   * and passes `approvalOpen`.
   */
  private humanCall(call: CallContext): CallContext {
    const { runtime } = this.host;
    return {
      ...call,
      mode: modeForSession(runtime.config, call.sessionKind),
    };
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
    let cwd = process.cwd();
    try {
      cwd = await this.ensureCwd(agent, exec.signal);
    } catch {
      /* Keep process cwd; the snapshot records the actual value. */
    }
    // Capture the configuration *after* the await: rules, mode and the recorded
    // revision must all describe the moment the evaluation actually runs, not
    // the moment the call entered the gate.
    const view = stageView(
      runtime.config,
      runtime.effectiveRevision,
      runtime.configSnapshotId,
      sessionKind,
    );
    const { mode, strategy, thresholds } = view;
    // Entries and the facts about them are read together, so an in-flight call
    // cannot pair one observation's window with another's completeness claim.
    const history = this.history.windowFor(session.id ?? 'unknown');
    const prior = history.items;
    // The evaluated set is what the matcher indexes into, so it is also what the
    // historical rule name must be resolved against.
    const evaluatedRules = view.config.rules.filter(
      (rule) => rule.enabled !== false,
    );
    const evaluation = evaluateCall({
      rules: evaluatedRules,
      tool: exec.name,
      arguments: exec.arguments,
      identity: sessionKind,
      workspaceRoot: cwd,
      cwd,
      parentAuthorizationPresent: null,
      historyTruncated: history.status.windowTruncated,
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
      historyStatus: history.status,
      evaluation,
      evaluatedRules,
      thresholds,
      trace: [
        {
          stage: 'rule',
          result: path.kind === 'rule' ? path.verdict : 'review(default)',
          ...(path.kind === 'rule'
            ? {
                ruleId: path.ruleId,
                ...ruleNameStage(
                  this.ruleNameOf(evaluatedRules, evaluation, path.ruleId),
                ),
              }
            : {}),
          ...(path.kind === 'review-default' ? { reason: path.reason } : {}),
          // The revision that decided this stage, from the same view the
          // evaluation used, so a later switch cannot relabel it.
          configRevision: view.revision,
          configSnapshotId: view.snapshotId,
          at: Date.now(),
        },
      ],
      view,
      extras: {
        effect: evaluation.facts === null ? null : { ...evaluation.facts },
        signals: null,
        snapshot: null,
        reviewReason: null,
        strategy,
        decisionRules: [],
        modelAttempts: [],
        ruleId: path.kind === 'rule' ? path.ruleId : null,
      },
    };
  }

  /**
   * The matched rule's display name at decision time.
   *
   * The match index refers to the *evaluated* list (disabled rules are filtered
   * out before matching), so the name is resolved against that same list. Using
   * the unfiltered configuration would point at the wrong rule whenever a
   * disabled rule precedes the match. A rule without a comment is labelled by
   * its id, the same way the rules table labels it.
   */
  private ruleNameOf(
    rules: readonly CommandRule[],
    evaluation: {
      readonly matches: readonly {
        readonly index: number;
        readonly id: string;
      }[];
    },
    ruleId: string,
  ): string | null {
    const match = evaluation.matches.find((entry) => entry.id === ruleId);
    if (match === undefined) return null;
    const rule = rules[match.index];
    if (rule === undefined || rule.id !== ruleId) return null;
    return rule.comment === undefined || rule.comment.length === 0
      ? rule.id
      : rule.comment;
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
      const reason = decisionFeedback({
        result: 'deny',
        ruleId: path.ruleId,
        decisionRules: [],
        reviewReason: null,
        snapshot: null,
      });
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
      // The snapshot must describe the configuration the rule evaluation used,
      // so a change landing while the snapshot is being built cannot make the
      // submitted request and the recorded revision disagree.
      config: call.view.config,
      facts: call.evaluation.facts,
      ...(hint === undefined ? {} : { hint }),
      priorVerdicts: call.prior,
      historyStatus: call.historyStatus,
      sessionRecordGap:
        runtime.sessionRecordErrors.get(call.exec.callId) ?? null,
      configRevision: call.view.revision,
    });
    return { bundle, llm };
  }

  private async review(call: PreparedCall): Promise<PreToolDecision> {
    if (this.history.breakerOpen(call.session.id ?? 'unknown')) {
      call.trace.push({
        stage: 'review',
        result: 'error-escalate',
        reason: 'circuit_open',
        configRevision: this.host.runtime.effectiveRevision,
        configSnapshotId: this.host.runtime.configSnapshotId,
        at: Date.now(),
      });
      return this.settlement.human(
        this.humanCall(call),
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
        configSnapshotId: this.host.runtime.configSnapshotId,
        at: Date.now(),
      });
      return this.settlement.human(this.humanCall(call), message, call.extras);
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
        configSnapshotId: this.host.runtime.configSnapshotId,
        at: Date.now(),
      });
      return this.settlement.human(this.humanCall(call), message, {
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
    const { lifecycle, services } = this.host;
    const thresholds = call.thresholds;
    // A NEW request uses the configuration effective at dispatch, not the one
    // captured before the snapshot was assembled; the response is then parsed by
    // this same frozen protocol even if the configuration changes again while
    // the request is out.
    const reviewer = this.host.runtime.config.reviewer;
    if (reviewer.type === 'chat') {
      lifecycle('review/start', {
        callId: call.exec.callId,
        sessionId: call.session.id ?? 'unknown',
      });
      const result = await runChatReviewer(
        {
          llm,
          session: call.session,
          chat: reviewer.chat,
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
        decision: reviewer.decision,
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
    // The response keeps the protocol that produced it (it was parsed before it
    // reached here), while the decision itself uses the configuration effective
    // when it forms. Capture that as one view so the mode, thresholds and the
    // revision written to the trace cannot disagree.
    const view = stageView(
      runtime.config,
      runtime.effectiveRevision,
      runtime.configSnapshotId,
      call.sessionKind,
    );
    const mode = view.mode;
    const current = { ...call, mode };
    const strategy = view.strategy;
    const thresholds = view.thresholds;
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
        configSnapshotId: runtime.configSnapshotId,
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
      configSnapshotId: runtime.configSnapshotId,
      at: Date.now(),
    });
    const reviewedExtras = {
      ...extras,
      signals,
      decisionRules: policy.decisionRules,
      reviewReason: policy.reason,
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
      const text = decisionFeedback({
        result: 'review-deny',
        ruleId: null,
        decisionRules: policy.decisionRules,
        reviewReason: modelReasonFor(policy),
        snapshot: bundle.snapshot,
      });
      this.settlement.finalize(current, 'review-deny', text, reviewedExtras);
      return deny(text);
    }
    return this.settlement.human(
      this.humanCall(current),
      `review requires a human decision: ${modelReasonFor(policy)}`,
      reviewedExtras,
    );
  }
}
