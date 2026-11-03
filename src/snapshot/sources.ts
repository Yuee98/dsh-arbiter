/** One live source capture; rebuilding a view never rereads a moving host/file. */
import type { SnapshotOptions } from '../snapshot.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { readSessionLog, type SessionLog } from './log.js';
import {
  readProjectRulesSource,
  projectRulesCopy,
  type ProjectRulesResult,
} from './guidance.js';
import type { ReviewEventSource, ReviewEventSources } from '../types.js';
import {
  beforePending,
  boundSourceLog,
  hostEventSource,
} from './host-events.js';
import { boundEventSources } from './source-guard.js';
import { resultContent } from './event-content.js';
import { currentTurnOf } from './window.js';
import { redactEventSources } from './prefix-redaction.js';
import { discoverLog, redactLog } from './source-redaction.js';
import { prepareToolResultLog, enrichToolResults } from './tool-results.js';

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
function capturedEvents(
  options: SnapshotOptions,
  log: SessionLog,
  parentLog: SessionLog | undefined,
  reader: SnapshotOptions['toolResults'],
) {
  const sessionId = options.agent.session.id ?? 'unknown';
  const eventSources =
    options.eventSources ??
    (reader === undefined
      ? undefined
      : {
          local: enrichToolResults(
            hostEventSource(
              log,
              sessionId,
              options.agent.session.header?.parentSession,
            ),
            log,
            reader,
          ),
          parent:
            parentLog === undefined
              ? unavailableParent(options.agent.session.header?.parentSession)
              : hostEventSource(
                  parentLog,
                  options.agent.session.header?.parentSession ?? 'unknown',
                  undefined,
                  true,
                ),
        });
  const frozenEvents =
    eventSources === undefined
      ? undefined
      : structuredClone(boundEventSources(eventSources));
  return frozenEvents;
}
function unavailableParent(
  parentId: string | undefined,
): ReviewEventSource | null {
  return parentId === undefined
    ? null
    : {
        status: {
          sessionId: parentId,
          status: 'unavailable',
          cutoff: null,
          fromSeq: null,
          reason: 'direct parent session is unavailable',
          access: 'snapshot',
        },
        events: [],
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
  const prefix = beforePending(captured, options.callId);
  const reader =
    options.eventSources === undefined ? options.toolResults : undefined;
  const sessionId = options.agent.session.id ?? 'unknown';
  const prepared =
    reader === undefined
      ? prefix
      : prepareToolResultLog(prefix, sessionId, reader);
  const observed = boundSourceLog(
    prepared,
    options.agent.session.id ?? 'unknown',
    options.agent.session.header?.parentSession,
  );
  const own = structuredClone(observed.own);
  const log = { ...observed, events: own, own, turnOf: [...observed.turnOf] };
  const parentLog = captureParentLog(options);
  const frozenEvents = capturedEvents(options, log, parentLog, reader);
  const project =
    options.projectRulesMaterial ??
    (await readProjectRulesSource(
      options.cwd,
      options.config.context.projectRules,
    ));
  return {
    turn,
    ...(frozenEvents === undefined
      ? {}
      : {
          eventSources: frozenEvents,
        }),
    log,
    ...(parentLog === undefined ? {} : { parentLog }),
    project: structuredClone(project),
    createdAt: Date.now(),
  };
}
/** Omit ordinary result media using original tags after complete raw discovery.
 * Human ask answers retain their original content/block processing path.
 */
function redactCapturedLog(
  log: SessionLog,
  redactor: CredentialRedactor,
  sessionId: string,
  parentId?: string,
  parent = false,
): SessionLog {
  const ordinaryResults = new Set(
    hostEventSource(log, sessionId, parentId, parent).events.flatMap((event) =>
      event.kind === 'result' ? [event.seq] : [],
    ),
  );
  return redactLog(log, redactor, (event, content) =>
    (event.type === 'tool/result' || event.type === 'tool/ptc-dispatch') &&
    ordinaryResults.has(event.seq)
      ? resultContent(content)
      : content,
  );
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
    log: redactCapturedLog(
      source.log,
      redactor,
      options.agent.session.id ?? 'unknown',
      options.agent.session.header?.parentSession,
    ),
    ...(source.parentLog === undefined
      ? {}
      : {
          parentLog: redactCapturedLog(
            source.parentLog,
            redactor,
            options.agent.session.header?.parentSession ?? 'unknown',
            undefined,
            true,
          ),
        }),
    project: projectRulesCopy(source.project, redactor),
    createdAt: source.createdAt,
  };
}
