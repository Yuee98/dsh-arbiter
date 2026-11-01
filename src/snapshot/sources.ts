/** One live source capture; rebuilding a view never rereads a moving host/file. */
import type { SnapshotOptions } from '../snapshot.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { readSessionLog, type SessionLog } from './log.js';
import {
  readProjectRulesSource,
  projectRulesCopy,
  type ProjectRulesResult,
} from './guidance.js';
import { discoverLog, redactLog } from './source-redaction.js';

export interface SnapshotSources {
  readonly log: SessionLog;
  readonly parentLog?: SessionLog;
  readonly project: ProjectRulesResult;
  readonly createdAt: number;
}
export async function captureSnapshotSources(
  options: SnapshotOptions,
): Promise<SnapshotSources> {
  const observed = readSessionLog(options.agent.session);
  const log = {
    ...observed,
    events: [...observed.events],
    own: [...observed.own],
    turnOf: [...observed.turnOf],
  };
  const parentId = options.agent.session.header?.parentSession;
  const parent =
    parentId === undefined ? undefined : options.sessions?.get?.(parentId);
  const parentObserved =
    parent === undefined
      ? undefined
      : readSessionLog(parent, `parent session "${parent.id ?? 'unknown'}"`);
  const parentLog =
    parentObserved === undefined
      ? undefined
      : {
          ...parentObserved,
          events: [...parentObserved.events],
          own: [...parentObserved.own],
          turnOf: [...parentObserved.turnOf],
        };
  const project = await readProjectRulesSource(
    options.cwd,
    options.config.context.projectRules,
  );
  return {
    log,
    ...(parentLog === undefined ? {} : { parentLog }),
    project,
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
    source.project.text,
    options.config.context.customRules,
    options.arguments,
    options.facts,
    options.priorVerdicts,
    options.hint,
  ]);
  return {
    log: redactLog(source.log, redactor),
    ...(source.parentLog === undefined
      ? {}
      : { parentLog: redactLog(source.parentLog, redactor) }),
    project: projectRulesCopy(source.project, redactor),
    createdAt: source.createdAt,
  };
}
