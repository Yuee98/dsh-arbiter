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
  /**
   * Sessions the gate must refuse, and the subset a *refusal* marked.
   *
   * The two promises differ: a teardown restores the full exit boundary, while a
   * refusal only guaranteed a safe sandbox and deliberately left a stricter
   * approval policy alone. Recovery has to verify the right one.
   */
  private readonly marked = new Set<string>();
  private readonly refusedMarks = new Set<string>();

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

  /** Mark one session, recording whether a refusal rather than teardown did it. */
  mark(sessionId: string, byRefusal: boolean): void {
    this.marked.add(sessionId);
    if (byRefusal) this.refusedMarks.add(sessionId);
    else this.refusedMarks.delete(sessionId);
  }

  /** Whether this session is marked at all. */
  isMarked(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.marked.has(sessionId);
  }

  /** Whether this session's mark came from a coexistence refusal. */
  isRefusalMarked(sessionId: string | undefined): boolean {
    return sessionId !== undefined && this.refusedMarks.has(sessionId);
  }

  /** Every marked session, in insertion order. */
  markedIds(): readonly string[] {
    return [...this.marked];
  }

  /** Forget one mark, once recovery is confirmed. */
  clearMark(sessionId: string): void {
    this.marked.delete(sessionId);
    this.refusedMarks.delete(sessionId);
  }

  /** Stop holding one session, once the widening may legitimately apply. */
  release(sessionId: string): void {
    this.held.delete(sessionId);
  }
}
