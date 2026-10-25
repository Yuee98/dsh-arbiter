/**
 * Pure session-admission logic.
 *
 * A session is taken over only when the backend has an explicit, durable
 * admission for it (or for the main session it descends from). Nothing here
 * reads the global plugin flag, a host preset name, or the effective knob
 * values: "arbiter is installed", "the host shows workspace-write" and "the
 * user once widened this session" are not admission proofs.
 *
 * The durable proof is one ignorable `plugin:arbiter/admission` record per
 * switch; the latest valid record wins. Folding is a pure function of the
 * committed event list, so a cold restore, a reconnect and a re-read all
 * derive the same state without SQLite.
 */

import { stableHash } from '../config.js';
import { recordOf } from '../records.js';
import type { PluginRecordEventLike } from '../records.js';
import type { SessionEventLike } from '../snapshot.js';
import type {
  AdmissionScope,
  AdmissionScopeReason,
  ArbiterConfig,
  ExecutionBoundary,
  SessionAdmission,
} from '../types.js';

/** The record type that carries one session's switch. */
export const ADMISSION_RECORD_TYPE = 'plugin:arbiter/admission';
export const ADMISSION_VERSION = 1;

/**
 * A parent chain longer than this cannot come from the host's own delegation
 * model; treat it as unresolvable instead of walking an arbitrarily long or
 * corrupted chain.
 */
export const MAX_PARENT_DEPTH = 16;

export interface FoldedAdmission {
  readonly enabled: boolean;
  readonly boundary: ExecutionBoundary;
  readonly seq: number;
  readonly at: number;
}

export function isExecutionBoundary(
  value: unknown,
): value is ExecutionBoundary {
  return value === 'guarded' || value === 'trusted';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one committed event as an admission record.
 *
 * Only records the host itself would retain and skip (`ignorable`, `plugin:`
 * namespace) are accepted; a foreign plugin record is not this plugin's state.
 */
export function admissionRecordOf(
  event: PluginRecordEventLike,
): FoldedAdmission | null {
  const record = recordOf(event);
  if (record === undefined || record.type !== ADMISSION_RECORD_TYPE)
    return null;
  const data: unknown = record.data;
  if (!isRecord(data)) return null;
  if (data['version'] !== ADMISSION_VERSION) return null;
  if (typeof data['enabled'] !== 'boolean') return null;
  if (!isExecutionBoundary(data['boundary'])) return null;
  if (typeof data['at'] !== 'number' || !Number.isFinite(data['at']))
    return null;
  return {
    enabled: data['enabled'],
    boundary: data['boundary'],
    seq: record.seq,
    at: data['at'],
  };
}

interface CommandRun {
  readonly name: string;
  readonly args: string;
}

function commandRunOf(event: SessionEventLike): {
  readonly commandId: string;
  readonly run: CommandRun;
} | null {
  if (event.type !== 'command/run' || !isRecord(event.data)) return null;
  const commandId = event.data['commandId'];
  const name = event.data['name'];
  if (typeof commandId !== 'string' || typeof name !== 'string') return null;
  return {
    commandId,
    run: {
      name,
      args: typeof event.data['args'] === 'string' ? event.data['args'] : '',
    },
  };
}

/** Whether one event settles a native `/permission <preset>` as successful. */
function nativeExitOf(
  event: SessionEventLike,
  runs: ReadonlyMap<string, CommandRun>,
): boolean {
  if (event.type !== 'command/done' || !isRecord(event.data)) return false;
  const commandId = event.data['commandId'];
  if (typeof commandId !== 'string') return false;
  const run = runs.get(commandId);
  if (run === undefined) return false;
  // A bare command only reports the preset; a failed one proves no switch.
  return (
    run.name === 'permission' &&
    run.args.trim().length > 0 &&
    event.data['kind'] === 'success'
  );
}

/**
 * Fold the latest admission record.
 *
 * A malformed or foreign record is skipped rather than defaulted: guessing
 * `enabled: true` from a corrupt record would take over a session the user
 * never enabled.
 *
 * A completed successful native `/permission <preset>` command after the last
 * admission record is an exit too. The same-value case (`/permission
 * workspace-write` while already at workspace-write) writes no permission
 * event at all, so the command pair is the only durable proof that the user
 * left; relying only on the plugin's deferred record would re-admit the
 * session after a successful exit if that write never landed.
 */
export function foldAdmission(
  events: readonly SessionEventLike[],
): FoldedAdmission | null {
  let latest: FoldedAdmission | null = null;
  const runs = new Map<string, CommandRun>();
  for (const event of events) {
    const folded = admissionRecordOf(event);
    if (folded !== null) latest = folded;
    const command = commandRunOf(event);
    if (command !== null) {
      runs.set(command.commandId, command.run);
      continue;
    }
    if (!nativeExitOf(event, runs)) continue;
    if (latest !== null && event.seq <= latest.seq) continue;
    const time: unknown = event.time;
    latest = {
      enabled: false,
      boundary: latest?.boundary ?? 'guarded',
      seq: event.seq,
      at: typeof time === 'number' && Number.isFinite(time) ? time : Date.now(),
    };
  }
  return latest;
}

/** Stable identity of one admission state, reported to clients. */
export function admissionRevision(
  sessionId: string,
  folded: FoldedAdmission,
): string {
  return stableHash(
    JSON.stringify([
      ADMISSION_RECORD_TYPE,
      ADMISSION_VERSION,
      sessionId,
      folded.enabled,
      folded.boundary,
      folded.seq,
      folded.at,
    ]),
  );
}

export function toAdmission(
  sessionId: string,
  rootSessionId: string,
  folded: FoldedAdmission,
): SessionAdmission {
  return {
    sessionId,
    rootSessionId,
    enabled: folded.enabled,
    boundary: folded.boundary,
    seq: folded.seq,
    at: folded.at,
    admissionRevision: admissionRevision(sessionId, folded),
  };
}

/** The host knobs one boundary applies to an enabled session. */
export function boundaryKnobs(boundary: ExecutionBoundary): {
  readonly sandbox: string;
  readonly approval: string;
} {
  return boundary === 'trusted'
    ? { sandbox: 'danger-full-access', approval: 'ask' }
    : { sandbox: 'workspace-write', approval: 'ask' };
}

/** The configured boundary, tolerant of a runtime built before the field. */
export function configuredBoundary(config: ArbiterConfig): ExecutionBoundary {
  const value: unknown = config.boundary;
  return isExecutionBoundary(value) ? value : 'guarded';
}

/** The chain of session ids from a session up to its root, if resolvable. */
export interface ParentChain {
  readonly ids: readonly string[];
  readonly unresolved: string | null;
  readonly cycle: boolean;
}

/**
 * Walk `parentSession` links with a visited set and a depth cap.
 *
 * The starting id is `ids[0]`. A missing parent id, an unknown id and a cycle
 * are reported instead of being silently treated as a main session: an
 * unresolved parent must not inherit someone else's admission.
 */
export function parentChain(
  sessionId: string,
  parentOf: (id: string) => string | undefined,
): ParentChain {
  const ids: string[] = [sessionId];
  const seen = new Set<string>([sessionId]);
  let current = sessionId;
  for (let depth = 0; depth < MAX_PARENT_DEPTH; depth += 1) {
    const parent = parentOf(current);
    if (parent === undefined || parent.length === 0)
      return { ids, unresolved: null, cycle: false };
    if (seen.has(parent)) return { ids, unresolved: parent, cycle: true };
    seen.add(parent);
    ids.push(parent);
    current = parent;
  }
  return { ids, unresolved: current, cycle: false };
}

export interface ScopeLookup {
  /**
   * Folded admission for one session id, `null` when it has no valid record.
   * The lookup only answers for sessions the host can still resolve.
   */
  readonly admissionOf: (id: string) => FoldedAdmission | null;
  /** The direct parent id from the session header, `undefined` for a main. */
  readonly parentOf: (id: string) => string | undefined;
  /** Whether the id still identifies a session this runtime can read. */
  readonly known: (id: string) => boolean;
}

function unmanaged(
  reason: AdmissionScopeReason,
  unresolvedParent: string | null = null,
): AdmissionScope {
  return { managed: false, reason, admission: null, unresolvedParent };
}

/**
 * Resolve whether a call from this session is covered by an enabled admission.
 *
 * Rules, in order:
 *   1. the session's own enabled record admits it;
 *   2. an explicit disabled record on the session itself stops it, even when
 *      an ancestor is enabled (the closer switch wins);
 *   3. otherwise a subagent follows its parent chain, and is admitted only by
 *      the nearest ancestor carrying a record — which must be enabled;
 *   4. an unresolvable or cyclic chain is never admitted.
 */
export function resolveScope(
  sessionId: string,
  lookup: ScopeLookup,
): AdmissionScope {
  if (!lookup.known(sessionId))
    return unmanaged('parent-unresolved', sessionId);
  const direct = lookup.admissionOf(sessionId);
  if (direct !== null) {
    return direct.enabled
      ? {
          managed: true,
          reason: 'session-enabled',
          admission: toAdmission(sessionId, sessionId, direct),
          unresolvedParent: null,
        }
      : unmanaged('session-disabled');
  }
  const chain = parentChain(sessionId, lookup.parentOf);
  if (chain.cycle) return unmanaged('parent-cycle', chain.unresolved);
  for (const id of chain.ids.slice(1)) {
    if (!lookup.known(id)) return unmanaged('parent-unresolved', id);
    const folded = lookup.admissionOf(id);
    if (folded === null) continue;
    if (!folded.enabled) return unmanaged('parent-not-admitted');
    return {
      managed: true,
      reason: 'parent-session-enabled',
      admission: toAdmission(id, id, folded),
      unresolvedParent: null,
    };
  }
  // A chain that ends before any record means the main session was never
  // enabled; installation and configuration do not stand in for that.
  return unmanaged(
    chain.ids.length > 1 ? 'parent-not-admitted' : 'no-admission',
  );
}
