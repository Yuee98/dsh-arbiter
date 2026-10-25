import type { ArbiterConfig } from '../types.js';

/**
 * One effective retention policy and executor per resolved database path.
 *
 * Audit storage is per DSH data instance, not per profile, so two profiles that
 * point at the same file must not delete each other's rows under different
 * thresholds. The first store for a path publishes the policy; later stores
 * adopt it and report a conflict instead of overwriting it. A changed setting
 * from the owning profile is applied through the owning store's controlled
 * update path.
 *
 * The registry holds no database handle: it tracks identity and policy only, so
 * it can live outside the store without touching storage.
 */
export interface RetentionClaim {
  readonly days: number;
  readonly bytes: number;
  readonly conflict: boolean;
}

/** A store participating in one path's policy. */
export interface RetentionMember {
  readonly id: number;
}

interface RetentionOwnership {
  retentionDays: number;
  retentionBytes: number;
  /** The member allowed to execute cleanup for this database. */
  owner: RetentionMember;
  /** Every open member for this path, in open order. */
  readonly members: RetentionMember[];
  /**
   * The policy each member last asked for.
   *
   * A promoted owner must not republish its own unchanged profile configuration
   * over an explicitly changed instance policy, so a routine refresh is only
   * treated as an edit when the member's own request actually changed.
   */
  readonly requested: Map<number, { days: number; bytes: number }>;
}

const RETENTION_OWNERS = new Map<string, RetentionOwnership>();

let nextId = 1;

/** A fresh identity for one store; ids are never reused. */
export function retentionMemberId(): number {
  nextId += 1;
  return nextId;
}

/**
 * Claim or join the policy for a path.
 *
 * The first member publishes; another member adopts the published values and is
 * told whether it disagreed, so the caller can report a conflict rather than
 * silently reinterpreting the database.
 */
export function claimRetention(
  path: string,
  member: RetentionMember,
  config: ArbiterConfig['audit'],
): RetentionClaim {
  const existing = RETENTION_OWNERS.get(path);
  if (existing === undefined) {
    RETENTION_OWNERS.set(path, {
      retentionDays: config.retentionDays,
      retentionBytes: config.retentionBytes,
      owner: member,
      members: [member],
      requested: new Map([
        [
          member.id,
          { days: config.retentionDays, bytes: config.retentionBytes },
        ],
      ]),
    });
    return {
      days: config.retentionDays,
      bytes: config.retentionBytes,
      conflict: false,
    };
  }
  if (!existing.members.includes(member)) existing.members.push(member);
  const previous = existing.requested.get(member.id);
  const asked = { days: config.retentionDays, bytes: config.retentionBytes };
  existing.requested.set(member.id, asked);
  // A member whose own request did not change is doing a routine refresh; it
  // must not overwrite an instance policy somebody else changed explicitly.
  const changed =
    previous === undefined ||
    previous.days !== asked.days ||
    previous.bytes !== asked.bytes;
  if (existing.owner.id !== member.id || !changed) {
    // A routine refresh is not a disagreement: the caller keeps the effective
    // policy and must not be told it conflicts with itself. Only a member whose
    // own request differs *and* is not the owner is a real conflict.
    const isOwner = existing.owner.id === member.id;
    return {
      days: existing.retentionDays,
      bytes: existing.retentionBytes,
      conflict:
        !isOwner &&
        (existing.retentionDays !== config.retentionDays ||
          existing.retentionBytes !== config.retentionBytes),
    };
  }
  // The owner changed its own request: this is the controlled update path.
  existing.retentionDays = config.retentionDays;
  existing.retentionBytes = config.retentionBytes;
  return {
    days: config.retentionDays,
    bytes: config.retentionBytes,
    conflict: false,
  };
}

/** The live policy for a path, so a follower reads the owner's current values. */
export function retentionPolicyOf(
  path: string,
): { readonly days: number; readonly bytes: number } | null {
  const existing = RETENTION_OWNERS.get(path);
  return existing === undefined
    ? null
    : { days: existing.retentionDays, bytes: existing.retentionBytes };
}

/** Whether this member is the path's current cleanup executor. */
export function ownsRetention(path: string, member: RetentionMember): boolean {
  const existing = RETENTION_OWNERS.get(path);
  return existing === undefined || existing.owner.id === member.id;
}

/**
 * Remove one member, transferring ownership to a live member if needed.
 *
 * Deleting the entry instead would let the next opener install a new policy
 * while an existing member is still running, so the effective instance policy
 * could change just because another profile opened.
 */
export function releaseRetention(path: string, member: RetentionMember): void {
  const existing = RETENTION_OWNERS.get(path);
  if (existing === undefined) return;
  const index = existing.members.findIndex((entry) => entry.id === member.id);
  if (index >= 0) existing.members.splice(index, 1);
  existing.requested.delete(member.id);
  if (existing.members.length === 0) {
    RETENTION_OWNERS.delete(path);
    return;
  }
  if (existing.owner.id === member.id) {
    const successor = existing.members[0];
    if (successor !== undefined) existing.owner = successor;
  }
}

/**
 * Clear generation per database path.
 *
 * A clear must apply to the whole database, not only to the store that served
 * the request: another store sharing the file may still hold events queued
 * before the user clicked clear. A monotonic generation is used rather than a
 * timestamp, because two events can share a millisecond and a timestamp
 * comparison would then either resurrect cleared history or discard a
 * legitimate post-clear event.
 */
const CLEAR_GENERATIONS = new Map<string, number>();

/** The generation an event must carry to survive a later clear. */
export function clearGeneration(path: string): number {
  return CLEAR_GENERATIONS.get(path) ?? 0;
}

/** Advance the generation: events from earlier generations are stale. */
export function markCleared(path: string): void {
  CLEAR_GENERATIONS.set(path, clearGeneration(path) + 1);
}
