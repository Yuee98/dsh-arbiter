/**
 * The two bits of state that keep a refused activation refused.
 *
 * Detection may only influence an *activation*, never a running session, so the
 * decision has to outlive the request that made it:
 *   - a withheld widening must stay withheld, or the next lazy boundary sync
 *     grants exactly the permission the activation refused;
 *   - a refused resume must keep refusing, because admissions restore lazily and
 *     a record written before the refusal still folds to enabled.
 *
 * Both are keyed to the conflict, not to a timer: the hold is released when a
 * later read proves no conflict remains. Kept as a value object so the admission
 * service stays about ordering and this stays about the two rules.
 */
export class CoverageHold {
  /** Whether coverage may not begin at all while a conflict is running. */
  private refused = false;
  /** Sessions whose widening was withheld and must stay narrow. */
  private readonly held = new Set<string>();

  /** Whether a resume was refused and no later read has cleared it. */
  get refusalStands(): boolean {
    return this.refused;
  }

  /** Record that coverage may not begin, with no session enumeration needed. */
  refuse(): void {
    this.refused = true;
  }

  /** Clear the refusal once an observation proves the conflict is gone. */
  clear(): void {
    this.refused = false;
  }

  /** Remember that this session's widening was withheld. */
  hold(sessionId: string): void {
    this.held.add(sessionId);
  }

  /** Whether a boundary change for this session is currently withheld. */
  isHeld(sessionId: string): boolean {
    return this.held.has(sessionId);
  }

  /** Stop holding one session, once the widening may legitimately apply. */
  release(sessionId: string): void {
    this.held.delete(sessionId);
  }
}
