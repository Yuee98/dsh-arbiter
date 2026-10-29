import { settleRule, settleOutcome, stageOf } from '../policy.js';
import type {
  ApprovalChannel,
  SettlementInstruction,
} from '../review-contract/matrix.js';
import { REVIEW_CONTRACT_VERSION } from '../review-contract/index.js';
import type { ReviewOutcome } from '../review-contract/types.js';
import { askPolicyForSession } from '../config.js';
import { stageView, type StageView } from './stage.js';
import { decisionFeedback } from './feedback.js';
import { evaluateCall } from '../rules/match.js';
import type { HistoryStatus, ReviewScores } from '../types.js';
import { buildCallSnapshot } from './call-snapshot.js';
import {
  earlyReview,
  preRequestExit,
  reasonOf,
  reviewExtras,
  runReview,
  type Reviewed,
} from './gate-review.js';
import type { AgentLike, BuiltSnapshot } from '../snapshot.js';
import type {
  AdmissionScopeReason,
  CommandRule,
  PreToolDecision,
  PriorVerdictItem,
} from '../types.js';
import { ruleConjunctionStage } from './gate-conjunction.js';
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
  readonly extras: AuditExtras;
}

/** The trace field for a resolved historical rule name, or nothing. */
function ruleNameStage(name: string | null): { readonly ruleName?: string } {
  return name === null ? {} : { ruleName: name };
}

/** The identity every gate lifecycle row repeats about the call it decided. */
function callIdentity(
  exec: ToolExecutionLike,
  sessionId: string | undefined,
): {
  readonly callId: string;
  readonly tool: string;
  readonly sessionId: string | null;
} {
  return {
    callId: exec.callId,
    tool: exec.name,
    sessionId: sessionId ?? exec.agent?.session.id ?? null,
  };
}

/** What the audit row keeps about this evaluation. */
function auditEffect(
  evaluation: ReturnType<typeof evaluateCall>,
): Record<string, unknown> | null {
  const facts = evaluation.facts;
  const normalization = evaluation.normalization;
  if (facts === null && normalization === null) return null;
  return {
    ...(facts === null ? {} : { ...facts }),
    ...(normalization === null ? {} : { normalization }),
  };
}

/**
 * The stored score pair for one scored outcome.
 *
 * Only a `scored` outcome produces one. A material gap and a reviewer failure reach
 * a stage without a score, and recording a pair for them would state a number the
 * review never reached.
 */
function scoresOf(outcome: ReviewOutcome): ReviewScores | null {
  if (outcome.status !== 'scored') return null;
  return {
    contractVersion: REVIEW_CONTRACT_VERSION,
    source: outcome.source,
    risk: outcome.risk,
    authorization: outcome.authorization,
    requiredAuthorization: outcome.requiredAuthorization,
    verdict: outcome.verdict,
    audit: outcome.audit,
  };
}

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
        ...callIdentity(exec, undefined),
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
        ...callIdentity(exec, undefined),
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
        ...callIdentity(exec, sessionId),
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
   * handed back. The exception is a guarded session the host would not confine:
   * approving it would execute outside the workspace under a boundary this
   * plugin widened, so it is refused instead.
   */
  private skippedCall(
    exec: ToolExecutionLike,
    reason: AdmissionScopeReason,
    next: () => Promise<PreToolDecision>,
  ): Promise<PreToolDecision> | PreToolDecision {
    if (reason === 'boundary-unconfirmed') {
      this.host.lifecycle('gate/refused', {
        ...callIdentity(exec, undefined),
        reason,
      });
      return deny(
        'Not executed [boundary-unconfirmed]: the guarded boundary could not be confirmed on this session, so this call is refused rather than approved under a wider host permission.',
      );
    }
    this.host.lifecycle('gate/skipped', {
      ...callIdentity(exec, undefined),
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
      ...callIdentity(exec, session.id),
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
      mode: askPolicyForSession(runtime.config, call.sessionKind),
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
    const { mode } = view;
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
          ...ruleConjunctionStage(evaluation, path),
          // The revision that decided this stage, from the same view the
          // evaluation used, so a later switch cannot relabel it.
          configRevision: view.revision,
          configSnapshotId: view.snapshotId,
          at: Date.now(),
        },
      ],
      view,
      extras: {
        // The audit record keeps the evidence the decision used: the observed
        // effects and the command normalization (raw text, matched text, per-word
        // status). Both travel in the existing `effect` payload, so no schema
        // migration is needed and old rows stay readable.
        effect: auditEffect(evaluation),
        scores: null,
        reviewStage: null,
        usage: null,
        snapshot: null,
        reviewReason: null,
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

  /**
   * Apply the matched rule's deterministic verdict.
   *
   * The four verdicts keep their fixed precedence (`deny > force-ask >
   * force-review > allow`), which the matcher already resolved, so this maps the
   * winner to one settlement. `force-ask` under `no-ask`, or with no reachable
   * channel, becomes a fallback denial: a model review is not a substitute for the
   * person the rule requires, so it cannot be turned into a review or an allow.
   */
  private async applyRule(call: PreparedCall): Promise<PreToolDecision | null> {
    const path = call.evaluation.path;
    if (path.kind !== 'rule') return null;
    const settled = settleRule({
      verdict: path.verdict,
      ask: call.mode,
      channel: this.channelFor(call),
    });
    switch (settled.kind) {
      case 'review':
        return null;
      case 'allow':
        this.settlement.finalize(
          call,
          'allow',
          'Arbiter: a complete allow rule covered this call.',
          call.extras,
        );
        return { kind: 'allow' };
      case 'deny': {
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
      case 'ask-human':
        return this.settlement.human(call, settled.reason, call.extras);
      case 'fallback-deny':
        // A rule demanded a person and none could be asked. The record names the
        // rule, so the chain shows which deterministic verdict required it.
        return this.settlement.fallbackDeny(
          call,
          settled.reason,
          call.extras,
          path.ruleId,
        );
    }
  }

  /**
   * The approval channel this call could reach, if any.
   *
   * The answer is computed once per decision and reused by both the rule path and
   * the review path, so the two cannot disagree about whether a person exists. It
   * is also what the settlement records as the escalation's own reason when it
   * falls back.
   */
  private channelFor(call: CallContext): ApprovalChannel {
    const verdict = this.settlement.channel(call);
    return verdict.available
      ? { status: 'available' }
      : {
          status: 'unavailable',
          reason: verdict.unavailableText ?? 'no approval channel',
        };
  }

  private noteStage(
    call: PreparedCall,
    result: string,
    reason: string,
    decisionRules: readonly string[] = [],
  ): void {
    call.trace.push({
      stage: 'review',
      result,
      reason,
      ...(decisionRules.length === 0 ? {} : { decisionRules }),
      configRevision: this.host.runtime.effectiveRevision,
      configSnapshotId: this.host.runtime.configSnapshotId,
      at: Date.now(),
    });
  }

  /**
   * Run the review and settle what it produced.
   *
   * The pre-request exits (breaker, unbuildable snapshot, over-budget request,
   * insufficient material) are decided by `preRequestExit` so this method stays
   * linear: it either has a usable review to run or a final outcome to settle, and
   * the stage is recorded exactly once, by the path that produced it.
   */
  private async review(call: PreparedCall): Promise<PreToolDecision> {
    const breakerOpen = this.history.breakerOpen(call.session.id ?? 'unknown');
    let bundle: BuiltSnapshot | null = null;
    let prepareError: string | null = null;
    if (!breakerOpen) {
      try {
        bundle = (await buildCallSnapshot(this.host, call)).bundle;
      } catch (error) {
        prepareError = error instanceof Error ? error.message : String(error);
      }
    }
    const early = preRequestExit(this.host, {
      breakerOpen,
      bundle,
      prepareError,
    });
    if (early !== null) {
      this.noteStage(call, early.stage, early.code);
      return await this.settleReviewed(
        call,
        earlyReview(early.outcome, early.snapshot),
      );
    }
    // `preRequestExit` proved both of these exist for a proceeding review.
    if (bundle === null || this.host.services.llm === undefined)
      throw new Error('a review that proceeds must have a bundle and an llm');
    this.noteReview(call.session.id ?? 'unknown');
    const result = await runReview(
      this.host,
      call,
      this.host.services.llm,
      bundle,
    );
    // A cancellation that arrives while the request is already out does not undo
    // the attempts that reached the provider: they were sent and may have been
    // billed, so they are persisted with the cancellation instead of being
    // dropped. The host's disposition is still a cancellation — a cancelled
    // request must never be settled by the model's score.
    if (isAborted(call.exec.signal)) {
      return this.settlement.cancelledReview(
        call,
        'the call was cancelled while its review request was in flight',
        reviewExtras(call.extras, result),
      );
    }
    this.noteStage(call, stageOf(result.outcome), reasonOf(result.outcome));
    return await this.settleReviewed(call, result);
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

  /**
   * Settle one review outcome.
   *
   * The stage is recorded before the settlement runs: an escalation that becomes
   * a fallback denial was still an escalation, and the chain has to say so. The
   * matrix alone decides allow/deny; only where an escalation goes depends on the
   * ask policy and the channel.
   */
  private async settleReviewed(
    call: PreparedCall,
    reviewed: Reviewed,
  ): Promise<PreToolDecision> {
    const { runtime } = this.host;
    // The response keeps the protocol that produced it (it was parsed before it
    // reached here), while the decision itself uses the configuration effective
    // when it forms. Capture that as one view so the mode and the revision
    // written to the trace cannot disagree.
    const view = stageView(
      runtime.config,
      runtime.effectiveRevision,
      runtime.configSnapshotId,
      call.sessionKind,
    );
    const current: CallContext = { ...call, mode: view.mode };
    const extras: AuditExtras = {
      ...reviewExtras(call.extras, reviewed),
      scores: scoresOf(reviewed.outcome),
      reviewStage: stageOf(reviewed.outcome),
    };
    const instruction: SettlementInstruction = settleOutcome(
      reviewed.outcome,
      view.mode,
      this.channelFor(current),
    );
    switch (instruction.kind) {
      case 'allow':
        this.settlement.finalize(
          current,
          'review-allow',
          'Arbiter: the review allowed this call.',
          extras,
        );
        return { kind: 'allow' };
      case 'deny': {
        const text = decisionFeedback({
          result: 'review-deny',
          ruleId: null,
          decisionRules: [],
          reviewReason: instruction.reason,
          snapshot: reviewed.snapshot,
        });
        this.settlement.finalize(current, 'review-deny', text, extras);
        return deny(text);
      }
      case 'ask-human':
        return await this.settlement.human(
          this.humanCall(current),
          instruction.reason,
          extras,
        );
      case 'fallback-deny':
        return this.settlement.fallbackDeny(
          this.humanCall(current),
          instruction.reason,
          extras,
          null,
        );
    }
  }
}
