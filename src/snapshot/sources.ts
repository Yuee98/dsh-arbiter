/** One live source capture; rebuilding a view never rereads a moving host/file. */
import type { SnapshotOptions } from '../snapshot.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { readSessionLog, type SessionLog } from './log.js';
import {
  readProjectRulesSource,
  projectRulesCopy,
  type ProjectRulesResult,
} from './guidance.js';
import type { ReviewEventSources } from '../types.js';
import { beforePending, boundSourceLog } from './host-events.js';
import { boundEventSources } from './source-guard.js';
import { currentTurnOf } from './window.js';
import { redactEventSources } from './prefix-redaction.js';
import { discoverLog, redactLog } from './source-redaction.js';

export interface SnapshotSources {
  readonly eventSources?: ReviewEventSources;
  readonly turn: number | null;
  readonly log: SessionLog;
  readonly parentLog?: SessionLog;
  readonly project: ProjectRulesResult;
  readonly createdAt: number;
}
function captureParentLog(options: SnapshotOptions): SessionLog | undefined {
  const parentId = options.agent.session.header?.parentSession;
  const parent =
    parentId === undefined ? undefined : options.sessions?.get?.(parentId);
  const parentObserved =
    parent === undefined
      ? undefined
      : boundSourceLog(
          readSessionLog(parent, `parent session "${parent.id ?? 'unknown'}"`),
          parent.id ?? parentId ?? 'unknown',
          undefined,
          true,
        );
  return parentObserved === undefined
    ? undefined
    : {
        ...parentObserved,
        events: structuredClone(parentObserved.own),
        own: structuredClone(parentObserved.own),
        turnOf: [...parentObserved.turnOf],
      };
}
export async function captureSnapshotSources(
  options: SnapshotOptions,
): Promise<SnapshotSources> {
  const captured = readSessionLog(options.agent.session);
  const turn = currentTurnOf(
    captured,
    options.callId,
    options.turn ?? null,
  ).turn;
  const observed = boundSourceLog(
    beforePending(captured, options.callId),
    options.agent.session.id ?? 'unknown',
    options.agent.session.header?.parentSession,
  );
  const own = structuredClone(observed.own);
  const log = { ...observed, events: own, own, turnOf: [...observed.turnOf] };
  const parentLog = captureParentLog(options);
  const project =
    options.projectRulesMaterial ??
    (await readProjectRulesSource(
      options.cwd,
      options.config.context.projectRules,
    ));
  return {
    turn,
    ...(options.eventSources === undefined
      ? {}
      : {
          eventSources: structuredClone(
            boundEventSources(options.eventSources),
          ),
        }),
    log,
    ...(parentLog === undefined ? {} : { parentLog }),
    project: structuredClone(project),
    createdAt: Date.now(),
  };
}
export function redactSnapshotSources(
  source: SnapshotSources,
  options: SnapshotOptions,
  redactor: CredentialRedactor,
): SnapshotSources {
  discoverLog(source.log, redactor);
  if (source.parentLog !== undefined) discoverLog(source.parentLog, redactor);
  redactor.discover([
    source.log.error,
    source.parentLog?.error,
    source.project.missing,
    options.sessionRecordGap,
    options.historyStatus,
    source.project.text,
    options.config.context.customRules,
    options.arguments,
    options.facts,
    options.priorVerdicts,
    options.hint,
  ]);
  return {
    turn: source.turn,
    ...(source.eventSources === undefined
      ? {}
      : { eventSources: redactEventSources(source.eventSources, redactor) }),
    log: redactLog(source.log, redactor),
    ...(source.parentLog === undefined
      ? {}
      : { parentLog: redactLog(source.parentLog, redactor) }),
    project: projectRulesCopy(source.project, redactor),
    createdAt: source.createdAt,
  };
}
