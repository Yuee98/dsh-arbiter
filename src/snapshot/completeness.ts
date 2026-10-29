/**
 * M0: what this submission can and cannot see.
 *
 * The review has exactly three outcomes — scored, insufficient-material and
 * review-failure — and this module is the only thing that decides which of the
 * first two the *material* supports. It is deliberately conservative in one
 * direction: it reports what the host and adapter layer can identify reliably,
 * and never claims a semantic judgement the reviewer would have to make. "The
 * model chose to abstain" is not something this code can observe.
 *
 * Five kinds of observation are kept apart because they take different paths:
 *
 *   - `known-empty`: every source answered and the answer was "nothing here".
 *     An unconfigured source or a readable session with no human message is
 *     known-empty. It is not a failure and it does not block: a successfully
 *     read session with no authorization is exactly the A2 case.
 *   - `unreadable`: a source that should have answered did not, even after the
 *     bounded supplementary read. This is the one loss no answer can stand on,
 *     so it blocks.
 *   - `truncated`: material was found but this submission cannot carry all of
 *     it. It is an input fact, reported to the reviewer and never promoted into
 *     a material failure by itself.
 *   - `unrelated`: material outside the current turn was dropped on purpose.
 *     Losing it is the normal case, so it is reported and never blocks.
 *   - `summarized`: a lossy compaction summary exists. The originals remain in
 *     the event log, so it is context for a reader, not a gap.
 */

import type {
  MaterialAvailability,
  MaterialGap,
} from '../review-contract/index.js';
import type { MaterialCompleteness, MaterialGapItem } from '../types.js';

/**
 * Truncation is reported, never promoted into a material failure.
 *
 * A cut text is not a missing source: truncation is an input fact, it does not
 * decide the permission conclusion and it is not by itself a review failure.
 * The reviewer is told exactly what was cut, and the normal chain continues — a
 * shorter or split request recovers the action, and a cut permission keeps the
 * assessment conservative.
 *
 * The per-item and per-request caps are what bound the request, so re-reading
 * would return the same text: the bounded supplementary read already happened
 * at the source (`log.ts` reads twice before calling a source failed). What is
 * left is to describe the cut exactly — source, kind, and for evidence the
 * original length — so a person can see what the reviewer did not.
 */
const TRUNCATION_BLOCKS = false;

export interface CompletenessInput {
  /**
   * Which segments the input budget had to trim.
   *
   * Trimming happens after this module's first pass, so the snapshot builder
   * calls it again with the trims it actually made. Keeping the decision here
   * means one place owns "which cut blocks", rather than the budget module
   * growing a second opinion.
   */
  readonly trimmed: MaterialTrims;
  /** Whether the truncated evidence included this session's or the parent's words. */
  readonly truncatedHumanEvidence: boolean;
  readonly historyTruncated: boolean;
  readonly sessionReadable: boolean;
  readonly sessionError: string | null;
  readonly parentRequired: boolean;
  readonly parentReadable: boolean;
  readonly parentLive: boolean;
  readonly parentError: string | null;
  readonly compaction: boolean;
  readonly parentCompaction: boolean;
  readonly projectRules: {
    readonly enabled: boolean;
    readonly present: boolean;
    readonly missing: string | null;
  };
  readonly sessionRecordGap: string | null;
  readonly historyGap: readonly string[];
  readonly evidenceCount: number;
  /** Calls an earlier turn contributed; dropped on purpose, never blocking. */
  readonly earlierTurnCalls: number;
  /** Why the tool window could not be attributed to one turn, or `null`. */
  readonly windowGap: string | null;
  /** Calls the window selected; a gap about attribution needs some to matter. */
  readonly toolCallCount: number;
}

/** The segments the input budget can trim, as the trimmer reports them. */
export interface MaterialTrims {
  readonly action: boolean;
  readonly evidence: boolean;
  readonly toolArguments: boolean;
  readonly checkpoints: boolean;
  readonly priorVerdicts: boolean;
  readonly projectRules: boolean;
  readonly derivedFacts: boolean;
}

/** No trimming yet: the state the builder starts from. */
export const NO_TRIMS: MaterialTrims = {
  action: false,
  evidence: false,
  toolArguments: false,
  checkpoints: false,
  priorVerdicts: false,
  projectRules: false,
  derivedFacts: false,
};

function item(
  source: MaterialGapItem['source'],
  kind: MaterialGapItem['kind'],
  reason: string,
  blocking: boolean,
): MaterialGapItem {
  return { source, kind, reason, blocking };
}

/** Gaps about the session and its human evidence. */
function sessionItems(input: CompletenessInput): MaterialGapItem[] {
  const out: MaterialGapItem[] = [];
  if (!input.sessionReadable) {
    out.push(
      item(
        'session-human',
        'unreadable',
        `this session's event log could not be read${input.sessionError === null ? '' : ` (${input.sessionError})`}, so its human messages are unavailable rather than absent`,
        true,
      ),
    );
  } else if (input.evidenceCount === 0) {
    // A readable session with nothing in it is a fact, not a loss: the review
    // can still score this call, and A2 is the honest authorization level.
    out.push(
      item(
        'session-human',
        'known-empty',
        'no human authorization evidence is readable in this session',
        false,
      ),
    );
  }
  if (input.truncatedHumanEvidence) {
    out.push(
      item(
        'session-human',
        'truncated',
        'one or more authorization evidence messages were truncated; their trailing content is not available',
        TRUNCATION_BLOCKS,
      ),
    );
  } else if (input.trimmed.evidence) {
    out.push(
      item(
        'session-human',
        'truncated',
        'the evidence window was reduced by capacity; older human messages were not submitted',
        false,
      ),
    );
  }
  if (input.trimmed.checkpoints) {
    out.push(
      item(
        'checkpoints',
        'truncated',
        'compaction summaries were trimmed by the input budget',
        false,
      ),
    );
  }
  if (input.compaction) {
    out.push(
      item(
        'checkpoints',
        'summarized',
        'this session was compacted; a summary restores context and never authorizes, and pre-compaction messages remain readable in the log',
        false,
      ),
    );
  }
  return out;
}

/** Gaps about the direct parent's human evidence. */
function parentItems(input: CompletenessInput): MaterialGapItem[] {
  if (!input.parentRequired) return [];
  if (!input.parentLive) {
    return [
      item(
        'parent-human',
        'unreadable',
        'parent session is not live; parent human evidence is unavailable',
        true,
      ),
    ];
  }
  if (!input.parentReadable) {
    return [
      item(
        'parent-human',
        'unreadable',
        `parent session events could not be read${input.parentError === null ? '' : ` (${input.parentError})`}; parent human evidence is unavailable`,
        true,
      ),
    ];
  }
  const out: MaterialGapItem[] = [];
  if (input.parentCompaction) {
    out.push(
      item(
        'parent-human',
        'summarized',
        'the parent session was compacted; a summary may stand in for earlier parent messages in replay, while the originals stay in the log',
        false,
      ),
    );
  }
  return out;
}

/** Gaps about the configured guidance files. */
function guidanceItems(input: CompletenessInput): MaterialGapItem[] {
  const out: MaterialGapItem[] = [];
  if (input.projectRules.present) return out;
  if (input.projectRules.missing !== null) {
    // A file that exists but cannot be read is material that should have been
    // available; an enabled-but-absent file is a source the user never authored.
    const unreadable = input.projectRules.missing.includes('could not be read');
    out.push(
      item(
        'project-rules',
        unreadable ? 'unreadable' : 'known-empty',
        input.projectRules.missing,
        unreadable,
      ),
    );
  } else if (input.projectRules.enabled) {
    out.push(
      item(
        'project-rules',
        'known-empty',
        'PROJECT_RULES is enabled and no configured file exists; no project guidance is in force',
        false,
      ),
    );
  }
  return out;
}

/** Gaps about the history tied to this call. */
function historyItems(input: CompletenessInput): MaterialGapItem[] {
  const out: MaterialGapItem[] = [];
  if (input.sessionRecordGap !== null) {
    out.push(
      item('prior-verdicts', 'unreadable', input.sessionRecordGap, false),
    );
  }
  for (const reason of input.historyGap) {
    out.push(item('prior-verdicts', 'unreadable', reason, false));
  }
  if (input.historyTruncated || input.trimmed.priorVerdicts) {
    out.push(
      item(
        'prior-verdicts',
        'truncated',
        'the prior-verdict window was cut; older verdicts were not submitted',
        false,
      ),
    );
  }
  if (input.earlierTurnCalls > 0) {
    out.push(
      item(
        'tool-window',
        'unrelated',
        `${String(input.earlierTurnCalls)} earlier-turn tool call(s) are excluded: only the current turn's calls are review material`,
        false,
      ),
    );
  }
  if (input.windowGap !== null && input.toolCallCount > 0) {
    out.push(item('tool-window', 'unreadable', input.windowGap, false));
  }
  if (input.trimmed.toolArguments) {
    out.push(
      item(
        'tool-window',
        'truncated',
        'tool call arguments were shortened to the per-call character limit; the call identity and order are intact',
        TRUNCATION_BLOCKS,
      ),
    );
  }
  return out;
}

/** Gaps about the pending action itself. */
function actionItems(input: CompletenessInput): MaterialGapItem[] {
  const out: MaterialGapItem[] = [];
  if (input.trimmed.action) {
    out.push(
      item(
        'pending-action',
        'truncated',
        'the pending action text was truncated by the input budget; the original request is preserved separately',
        TRUNCATION_BLOCKS,
      ),
    );
  }
  if (input.trimmed.projectRules) {
    out.push(
      item(
        'project-rules',
        'truncated',
        'PROJECT_RULES was omitted by the input budget; no project guidance was submitted',
        false,
      ),
    );
  }
  if (input.trimmed.derivedFacts) {
    out.push(
      item(
        'pending-action',
        'truncated',
        'derived facts about the pending action were reduced by the input budget',
        false,
      ),
    );
  }
  return out;
}

/**
 * Build the completeness report from what the readers observed.
 *
 * `status` is derived, never asserted: `insufficient` requires a blocking item,
 * which only an unreadable required source or a cut human permission produces.
 * The review-contract `gaps` carry exactly those blocking items, so a later
 * decision layer cannot escalate on a non-blocking note or ignore a real loss.
 */
export function buildCompleteness(
  input: CompletenessInput,
): MaterialCompleteness {
  const items = [
    ...actionItems(input),
    ...sessionItems(input),
    ...parentItems(input),
    ...guidanceItems(input),
    ...historyItems(input),
  ];
  const blocking = items.filter((entry) => entry.blocking);
  const gaps: MaterialGap[] = blocking.map((entry) => ({
    source: entry.source,
    reason: entry.reason,
  }));
  const status: MaterialCompleteness['status'] =
    blocking.length > 0
      ? 'insufficient'
      : items.length > 0
        ? 'incomplete'
        : 'complete';
  return {
    status,
    items,
    gaps,
    // The summary is one sentence for a human reader; it names the blocking
    // sources only, because those are the ones that change the outcome.
    note:
      blocking.length === 0
        ? null
        : `required review material is unavailable: ${blocking
            .map((entry) => `${entry.source} (${entry.kind})`)
            .join(', ')}`,
  };
}

/**
 * This submission's material in the shared review contract's terms.
 *
 * The contract decides `scored` versus `insufficient-material` from exactly this
 * value, so the snapshot does not keep a second opinion: a review whose blocking
 * gaps are non-empty cannot be settled as a scored decision, and one with no
 * blocking gap is available even when ordinary notes exist.
 */
export function materialAvailabilityOf(
  completeness: MaterialCompleteness,
): MaterialAvailability {
  return completeness.gaps.length === 0
    ? { status: 'available' }
    : { status: 'insufficient', gaps: completeness.gaps };
}

/**
 * The reported lines for the prompt's MISSING_INPUT block, in stable order.
 *
 * Every item is stated once: two trims of the same material are one fact for the
 * reviewer, and repeating the sentence would spend budget on no new information.
 */
export function missingLines(completeness: MaterialCompleteness): string[] {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const entry of completeness.items) {
    if (entry.kind === 'unrelated' || seen.has(entry.reason)) continue;
    seen.add(entry.reason);
    lines.push(entry.reason);
  }
  return lines;
}
