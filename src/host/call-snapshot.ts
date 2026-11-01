import { credentialRegistry } from '../reviewer/credential-registry.js';
import { workflowRedactor } from '../snapshot/workflow.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
/**
 * The gate's bridge to the snapshot builder.
 *
 * The gate knows things the builder cannot recover from the session log: the
 * configuration view the rule evaluation used, the history status its own
 * selection observed, the recorded session-record error, and the turn the host
 * announced through `turn/start` before this call's own event was written. This
 * module hands exactly those over, and nothing else, so the builder stays a pure
 * function of what it is given.
 */

import {
  prepareReviewSnapshot,
  type BuiltSnapshot,
  type SessionLike,
} from '../snapshot.js';
import type { LlmLike } from '../reviewer.js';
import type { evaluateCall } from '../rules/match.js';
import type { StageView } from './stage.js';
import type { HostEnvironment } from './types.js';
import type { CallContext } from './types.js';
import type { HistoryStatus, PriorVerdictItem } from '../types.js';

/**
 * The prepared call, as this step needs it.
 *
 * It restates the fields rather than importing the gate's own `PreparedCall`, so
 * the gate keeps ownership of what a prepared call is and this module states
 * only the part the material depends on.
 */
export interface SnapshotCall extends CallContext {
  readonly evaluation: ReturnType<typeof evaluateCall>;
  readonly prior: readonly PriorVerdictItem[];
  readonly historyStatus: HistoryStatus;
  readonly view: StageView;
}

export interface SnapshotBundle {
  readonly bundle: BuiltSnapshot;
  readonly llm: LlmLike;
  readonly rebuild: (known?: readonly string[]) => BuiltSnapshot;
}

/**
 * Build the request material for this call.
 *
 * `llm` is returned with the bundle because both are required before a review
 * can start, and reading it here means a missing service fails before the
 * material work rather than after it.
 */
export async function buildCallSnapshot(
  host: HostEnvironment,
  call: SnapshotCall,
): Promise<SnapshotBundle> {
  const { runtime, services } = host;
  const llm = services.llm;
  if (llm === undefined) throw new Error('llm service is unavailable');
  const path = call.evaluation.path;
  const hint =
    path.kind === 'rule' && path.verdict === 'force-review'
      ? path.hint
      : undefined;
  const sessionId = call.session.id;
  const prepared = await prepareReviewSnapshot(
    {
      agent: call.agent,
      ...(services.sessions === undefined
        ? {}
        : { sessions: services.sessions }),
      // The host's own turn, from `turn/start`: this call's event is written
      // after the decision, so the window cannot read it from the log.
      turn:
        sessionId === undefined
          ? null
          : (runtime.currentTurn.get(sessionId) ?? null),
      tool: call.exec.name,
      arguments: call.exec.arguments,
      callId: call.exec.callId,
      cwd: call.cwd,
      // The snapshot must describe the configuration the rule evaluation used, so
      // a change landing mid-build cannot make the submitted request and the
      // recorded revision disagree.
      config: call.view.config,
      facts: call.evaluation.facts,
      ...(hint === undefined ? {} : { hint }),
      priorVerdicts: call.prior,
      historyStatus: call.historyStatus,
      sessionRecordGap:
        runtime.sessionRecordErrors.get(call.exec.callId) ?? null,
      configRevision: call.view.revision,
    },
    callRedactor(host, call.session),
  );
  return { ...prepared, llm };
}

/** Share only in-memory workflow knowledge with the audit connection's domain. */
export function callRedactor(
  host: HostEnvironment,
  session: SessionLike,
): CredentialRedactor {
  return workflowRedactor(
    session,
    host.services.sessions,
    credentialRegistry(host, host.currentAudit()?.databasePath),
  );
}
