/**
 * Assembling the evidence stream and its parent-session facts.
 *
 * Evidence is the one material that crosses turns: a human permission or
 * restriction stays in force until something newer and applicable conflicts
 * with it. So this module reads the parent chain, merges the layers by source
 * priority while reserving the newest human statement, and reports presence as
 * three states instead of two.
 *
 * The parent read is a separate log read — it is a different session with its
 * own turns and its own failures — and a parent that cannot be read yields no
 * evidence plus a reported gap, never an empty parent.
 */

import type { ArbiterConfig, EvidenceItem } from '../types.js';
import type { SessionLike, SessionsLike } from './types.js';
import type { SessionLog } from './log.js';
import {
  compacted,
  humanEvidence,
  mergeEvidence,
  relayEvents,
} from './evidence.js';
import { readSessionLog } from './log.js';

export interface EvidenceState {
  readonly sessionEvidence: readonly EvidenceItem[];
  readonly parentEvidence: readonly EvidenceItem[];
  readonly relay: readonly EvidenceItem[];
  readonly merged: {
    readonly evidence: EvidenceItem[];
    readonly truncated: boolean;
  };
  readonly parentAuthorizationPresent: boolean | null;
  readonly parentReadable: boolean;
  readonly parentLive: boolean;
  readonly parentError: string | null;
  readonly compaction: boolean;
  readonly parentCompaction: boolean;
  /** Whether any human evidence item lost its trailing text to the item cap. */
  readonly truncatedHumanEvidence: boolean;
}

/**
 * Three-state parent authorization presence.
 *
 * `true` and `false` are affirmative claims about the parent's human history, so
 * they require a live, readable, uncompacted read of it. Everything else — no
 * parent, an unreadable log, or a summary that may have replaced the originals —
 * is `null` (unknown), which the reviewer treats as "could not verify" rather
 * than "there was nothing".
 */
function parentPresence(
  isMainSession: boolean,
  parent: SessionLike | undefined,
  readableParent: boolean,
  compactedParent: boolean,
  hasHumanEvidence: boolean,
): boolean | null {
  if (isMainSession || parent === undefined) return null;
  if (!readableParent) return null;
  if (hasHumanEvidence) return true;
  return compactedParent ? null : false;
}

function mergeSelection(
  sessionHuman: readonly EvidenceItem[],
  parentHuman: readonly EvidenceItem[],
  relay: readonly EvidenceItem[],
  contextConfig: ArbiterConfig['context'],
): { readonly evidence: EvidenceItem[]; readonly truncated: boolean } {
  return mergeEvidence(sessionHuman, parentHuman, relay, {
    maxItems: contextConfig.evidenceMaxItems,
    parentHumanItems: contextConfig.parentHumanItems,
    parentFloor: contextConfig.parentEvidenceFloor,
  });
}

export interface AssembleEvidenceOptions {
  readonly session: SessionLike;
  readonly parentId: string | undefined;
  readonly sessions: SessionsLike | undefined;
  readonly contextConfig: ArbiterConfig['context'];
}

/** The direct parent's log and human evidence, when there is a parent. */
interface ParentEvidence {
  readonly live: boolean;
  readonly log: SessionLog | null;
  readonly evidence: readonly EvidenceItem[];
  readonly compacted: boolean;
}

function readParent(parent: SessionLike | undefined): ParentEvidence {
  if (parent === undefined) {
    return { live: false, log: null, evidence: [], compacted: false };
  }
  const log = readSessionLog(
    parent,
    `parent session "${parent.id ?? 'unknown'}"`,
  );
  return {
    live: true,
    log,
    // An unreadable parent supplies nothing; the gap is reported, so an empty
    // list must never be read as "the parent had no human input".
    evidence: log.readable
      ? humanEvidence(log, 'parent-human', parent.id ?? 'unknown')
      : [],
    compacted: log.readable && compacted(log),
  };
}

/**
 * Read this session's and its direct parent's evidence, then merge the layers.
 *
 * The parent's log is read even when this session produced no evidence, because
 * presence is a fact about the parent and a child's silence says nothing about
 * it.
 */
export function assembleEvidence(
  log: SessionLog,
  options: AssembleEvidenceOptions,
): EvidenceState {
  const sessionEvidence = humanEvidence(
    log,
    'session-human',
    options.session.id ?? 'unknown',
  );
  const parentLog =
    options.parentId === undefined
      ? undefined
      : options.sessions?.get?.(options.parentId);
  const parent = readParent(parentLog);
  const relay =
    options.parentId === undefined ? [] : relayEvents(log, options.parentId);
  return {
    sessionEvidence,
    parentEvidence: parent.evidence,
    relay,
    merged: mergeSelection(
      sessionEvidence,
      parent.evidence,
      relay,
      options.contextConfig,
    ),
    parentAuthorizationPresent: parentPresence(
      options.parentId === undefined,
      parentLog,
      parent.log?.readable ?? false,
      parent.compacted,
      parent.evidence.length > 0,
    ),
    parentReadable: parent.log?.readable ?? false,
    parentLive: parent.live,
    parentError: parent.log?.error ?? null,
    compaction: compacted(log),
    parentCompaction: parent.compacted,
    truncatedHumanEvidence: [...sessionEvidence, ...parent.evidence].some(
      (item) => item.truncated === true,
    ),
  };
}
