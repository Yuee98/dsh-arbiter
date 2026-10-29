/**
 * Turning one committed case into the material the production reviewer reads.
 *
 * This is the seam between the dataset and the reviewer, and it is deliberately
 * thin: the case supplies the *content*, and every decision about how that content
 * becomes a submission is the production one. The order and labelling of blocks
 * come from `renderMaterial`, the input budget from `truncateSnapshot`, the M0
 * report from `buildCompleteness`, and the derived action facts from the same
 * `evaluateCall` the gate uses. Nothing here reimplements any of them: a second
 * implementation that agreed today would be a second thing to keep in step.
 *
 * What this module does own is the one thing production cannot know — which facts a
 * *case* declares. A case states its guidance text, its evidence items and whether
 * a parent subagent had recorded authorization. It has no session log, no live
 * parent and no rules file on disk. `entryPoint` in the record says exactly that, so
 * a report cannot read a case-driven review as host behaviour.
 *
 * The rule for every such fact is the same: state what the case declares, and treat
 * an undeclared source as known-empty rather than unreadable. A case that lists no
 * evidence has no authorization evidence — a fact about the case, not a lost log —
 * and reporting it as a blocking gap would make every bare-policy case claim
 * `insufficient-material` for something it never asserted.
 */

import type {
  DerivedFacts,
  EvidenceItem,
  ReviewSnapshot,
} from '../../../src/types.js';
import {
  renderChatRequest,
  renderChatUser,
  renderDecisionRequest,
} from '../../../src/reviewer/prompt.js';
import { evaluateCall } from '../../../src/rules/match.js';
import { truncateSnapshot } from '../../../src/snapshot/budget.js';
import {
  buildCompleteness,
  missingLines,
  NO_TRIMS,
} from '../../../src/snapshot/completeness.js';
import type { CompletenessInput } from '../../../src/snapshot/completeness.js';
import {
  guidanceMaterials,
  readProjectRules,
} from '../../../src/snapshot/guidance.js';
import type { ProjectRulesResult } from '../../../src/snapshot/guidance.js';

import { digestOf } from '../data/hash.js';
import type { Evidence, ReviewCase } from '../data/types.js';

import type { CellMaterial, RunProtocol } from './types.js';

/** The rendered request one protocol submits, plus the snapshot behind it. */
export interface CaseMaterial {
  readonly snapshot: ReviewSnapshot;
  /** The exact submitted request for this protocol. */
  readonly request: unknown;
  readonly material: CellMaterial;
}

/**
 * One case's guidance, in the shape the production composer takes.
 *
 * A case's rules are supplied text rather than a file, so there is no read that
 * could fail: `missing` is null and `unreadable` is false. The per-source file cap
 * production applies to a read does not apply here either — the case is already the
 * document — but the shared guidance ceiling does, because `guidanceMaterials`
 * applies it to whatever it is given. That is the one cap that decides what a
 * submission can carry, so it stays production's.
 */
function caseGuidance(
  projectRules: string | null,
  customRules: string,
): { readonly project: ProjectRulesResult; readonly customRules: string } {
  return {
    project: {
      text: projectRules,
      material: {
        id: 'project-rules',
        enabled: true,
        present: projectRules !== null && projectRules.length > 0,
        chars: projectRules?.length ?? 0,
        limit: projectRules?.length ?? 0,
        truncated: false,
      },
      missing: null,
      unreadable: false,
    },
    customRules,
  };
}

/**
 * What a case declares about its own material, in the M0 report's vocabulary.
 *
 * The three sources production can lose — the session log, the parent session and
 * the rules file — are all present by construction: the case *is* the submission,
 * so its evidence list is the session's human evidence and its guidance text is the
 * rules. Nothing is claimed about a live parent beyond what the case says, which is
 * why the parent is never reported as unreadable here.
 */
function caseCompleteness(
  caseEntry: ReviewCase,
): Omit<CompletenessInput, 'trimmed'> {
  const input = caseEntry.input;
  return {
    truncatedHumanEvidence: false,
    protectedEvidenceDropped: [],
    historyTruncated: false,
    sessionReadable: true,
    sessionError: null,
    // A case states whether a parent had recorded authorization; it does not read
    // a parent session, so the parent is not a source this chain could have lost.
    parentRequired: false,
    parentReadable: true,
    parentLive: false,
    parentError: null,
    compaction: false,
    parentCompaction: false,
    projectRules: {
      enabled: true,
      present:
        input.policy.projectRules !== null &&
        input.policy.projectRules.length > 0,
      missing: null,
    },
    sessionRecordGap: null,
    historyGap: [],
    evidenceCount: input.evidence?.length ?? 0,
    earlierTurnCalls: 0,
    windowGap: null,
    hasToolCalls: (input.context?.length ?? 0) > 0,
  };
}

/**
 * The derived action facts for a case.
 *
 * `evaluateCall` is the production evaluator: it parses the shell text, derives
 * observed effects and reports parse completeness. The case carries no command
 * rules, and that is not a loss — a rule-driven `allow` would bypass the reviewer
 * entirely, so a case meant to be reviewed must not match one.
 */
export function caseFacts(caseEntry: ReviewCase): DerivedFacts | null {
  const input = caseEntry.input;
  return evaluateCall({
    rules: [],
    tool: input.action.name,
    arguments: input.action.arguments,
    identity: input.session.kind,
    workspaceRoot: null,
    cwd: input.cwd ?? '/',
    parentAuthorizationPresent:
      input.session.parentAuthorizationPresent ?? null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  }).facts;
}

/**
 * The per-source cap production applies to a rules file.
 *
 * Exposed so the record can state the limit in force rather than restating a
 * number: the cap belongs to production, and a caller that wants to report it
 * should ask rather than copy. A non-existent directory with a non-existent file
 * name is enough, because the result carries the limit whether or not a file was
 * found.
 */
export async function guidanceLimit(): Promise<number> {
  const probe = await readProjectRules('/arbiter-evals-probe', {
    enabled: true,
    files: ['.arbiter-evals-probe-rules'],
  });
  return probe.material.limit;
}

/**
 * One evidence item, with the layer its own note names.
 *
 * `material-quote` quotes original human words, so it carries `explicit`
 * evidence; `link` and `note` restore context and authorize nothing, so their
 * `evidence` is null. That distinction is the design's, and it is what keeps a
 * provenance note from being read as permission. The source layer is read from the
 * note too: a quotation the note attributes to the direct parent belongs to that
 * layer, with its own conflict priority, rather than being flattened into this
 * session's words.
 */
function evidenceItem(caseId: string) {
  return (entry: Evidence, index: number): EvidenceItem => {
    const parent = entry.note?.includes('直接父会话') === true;
    return {
      ts: index,
      source: {
        kind: parent ? 'parent-human' : 'session-human',
        sessionId: caseId,
      },
      role: 'human-instruction',
      evidence: entry.kind === 'material-quote' ? 'explicit' : null,
      sourcePriority: parent ? 2 : 1,
      text: entry.ref,
    };
  };
}

/**
 * Build one case's material for one protocol.
 *
 * The snapshot is assembled from the case, trimmed by the production budget, then
 * rendered by the production renderer for the protocol asked. Both outputs are
 * kept: the snapshot is what the attempt replays, and the rendered request is what
 * the fingerprint names. Computing the fingerprint once here rather than per
 * attempt is what makes "two attempts with the same fingerprint sent the same
 * request" a fact rather than a hope.
 */
export function caseMaterial(
  caseEntry: ReviewCase,
  protocol: RunProtocol,
  options: { readonly maxInputTokens: number },
): CaseMaterial {
  const input = caseEntry.input;
  const guidance = caseGuidance(
    input.policy.projectRules,
    input.policy.customRules,
  );
  const guidanceResult = guidanceMaterials(
    guidance.customRules,
    guidance.project,
  );
  const itemOf = evidenceItem(caseEntry.caseId);
  const evidence = (input.evidence ?? []).map((entry, index) =>
    itemOf(entry, index),
  );
  const completenessInput = caseCompleteness(caseEntry);
  const base: Omit<ReviewSnapshot, 'budget'> = {
    version: 1,
    createdAt: 0,
    configRevision: `evals:${caseEntry.caseId}`,
    callId: caseEntry.caseId,
    sessionId: caseEntry.caseId,
    sessionKind: input.session.kind,
    tool: input.action.name,
    cwd: input.cwd ?? '/',
    turn: null,
    action: {
      name: input.action.name,
      arguments: input.action.arguments ?? {},
      ...(input.action.programText === undefined
        ? {}
        : { programText: input.action.programText }),
    },
    facts: caseFacts(caseEntry),
    ...(input.hint === undefined ? {} : { hint: input.hint }),
    projectRules: guidanceResult.projectText,
    customRules: guidanceResult.customRules,
    materials: guidanceResult.materials,
    evidence,
    evidenceTruncated: false,
    parentAuthorizationPresent:
      input.session.parentAuthorizationPresent ?? null,
    context: (input.context ?? []).map((turn, index) => ({
      ts: index,
      tool: turn.tool,
      arguments: turn.arguments,
    })),
    checkpoints: [],
    contextTruncated: false,
    priorVerdicts: [],
    historyTruncated: false,
    historyStatus: {
      coverage: input.context === undefined ? 'known-empty' : 'complete',
      windowTruncated: false,
      reason: null,
      sources: {
        memory: { read: 0, unavailable: null },
        session: { read: input.context?.length ?? 0, unavailable: null },
        audit: { read: 0, unavailable: null },
      },
      reset: false,
    },
    completeness: buildCompleteness({
      ...completenessInput,
      trimmed: NO_TRIMS,
    }),
    missing: missingLines(
      buildCompleteness({ ...completenessInput, trimmed: NO_TRIMS }),
    ),
  };
  const rendered = truncateSnapshot(
    base,
    options.maxInputTokens,
    completenessInput,
  );
  const snapshot = rendered.snapshot;
  const request =
    protocol === 'chat'
      ? renderChatRequest(snapshot)
      : renderDecisionRequest(renderChatUser(snapshot));
  const promptFingerprint = digestOf({ protocol, request });
  return {
    snapshot,
    request,
    material: {
      inputHash: digestOf(input),
      promptFingerprint,
      estimatedInputTokens: snapshot.budget.estimatedInputTokens,
      maxInputTokens: snapshot.budget.maxInputTokens,
      truncatedSegments: snapshot.budget.truncatedSegments,
      completenessStatus: snapshot.completeness.status,
      blockingGaps: snapshot.completeness.gaps,
      missing: missingLines(snapshot.completeness),
      notices: snapshot.completeness.items
        .filter((item) => !item.blocking)
        .map((item) => ({
          source: item.source,
          kind: item.kind,
          reason: item.reason,
        })),
    },
  };
}
