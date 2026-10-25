/** Input-budget trimming preserves the pending action and fixed review policy. */
import { renderRequest, renderSystem, renderUser } from '../reviewer.js';
import type { ReviewSnapshot } from '../types.js';

interface BudgetState {
  evidence: ReviewSnapshot['evidence'];
  context: ReviewSnapshot['context'];
  prior: ReviewSnapshot['priorVerdicts'];
  projectRules: ReviewSnapshot['projectRules'];
  facts: ReviewSnapshot['facts'];
  evidenceTruncated: boolean;
  contextTruncated: boolean;
  historyTruncated: boolean;
  readonly missing: Set<string>;
  readonly truncatedSegments: Set<string>;
}

function candidateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  state: BudgetState,
  maxInputTokens: number,
): ReviewSnapshot {
  return {
    ...base,
    missing: [...state.missing],
    evidence: state.evidence,
    context: state.context,
    priorVerdicts: state.prior,
    projectRules: state.projectRules,
    facts: state.facts,
    evidenceTruncated: state.evidenceTruncated,
    contextTruncated: state.contextTruncated,
    historyTruncated: state.historyTruncated,
    budget: {
      maxInputTokens,
      estimatedInputTokens: 0,
      truncatedSegments: [...state.truncatedSegments],
    },
  };
}

/** Remove one segment in the documented budget priority order. */
function truncateNext(state: BudgetState): boolean {
  if (state.evidence.length > 1) {
    state.evidence = state.evidence.slice(0, -1);
    state.evidenceTruncated = true;
    state.truncatedSegments.add('EVIDENCE');
    state.missing.add(
      'authorization evidence was truncated by the input budget',
    );
    return true;
  }
  if (state.context.length > 0) {
    state.context = state.context.slice(0, -1);
    state.contextTruncated = true;
    state.truncatedSegments.add('CONTEXT');
    state.missing.add(
      'prior tool-call context was truncated by the input budget',
    );
    return true;
  }
  if (state.prior.length > 0) {
    state.prior = state.prior.slice(0, -1);
    state.historyTruncated = true;
    state.truncatedSegments.add('PRIOR_VERDICTS');
    state.missing.add('prior verdicts were truncated by the input budget');
    return true;
  }
  if (state.projectRules !== null) {
    state.projectRules = null;
    state.truncatedSegments.add('PROJECT_RULES');
    return true;
  }
  if (state.facts === null) return false;
  const facts = state.facts;
  state.facts = {
    ...facts,
    observed: {
      writes: [],
      networkCommands: [],
      credentialPaths: [],
      pipelineExec: [],
      substitutions: facts.observed.substitutions,
      subshells: facts.observed.subshells,
    },
    completeness:
      facts.completeness === 'complete' ? 'partial' : facts.completeness,
    truncated: true,
  };
  state.truncatedSegments.add('DERIVED_FACTS');
  return true;
}

function renderedSnapshot(candidate: ReviewSnapshot): {
  readonly snapshot: ReviewSnapshot;
  readonly system: string;
  readonly user: string;
} {
  const estimated = renderRequest(candidate).estimatedInputTokens;
  const over = estimated > candidate.budget.maxInputTokens;
  return {
    snapshot: {
      ...candidate,
      budget: {
        ...candidate.budget,
        estimatedInputTokens: estimated,
        truncatedSegments: [
          ...new Set([
            ...candidate.budget.truncatedSegments,
            ...(over ? ['OVER_BUDGET'] : []),
          ]),
        ],
      },
    },
    system: renderSystem(candidate),
    user: renderUser(candidate),
  };
}

export function truncateSnapshot(
  base: Omit<ReviewSnapshot, 'budget'>,
  maxInputTokens: number,
): ReturnType<typeof renderedSnapshot> {
  const state: BudgetState = {
    evidence: [...base.evidence],
    context: [...base.context],
    prior: [...base.priorVerdicts],
    projectRules: base.projectRules,
    facts: base.facts,
    evidenceTruncated: base.evidenceTruncated,
    contextTruncated: base.contextTruncated,
    historyTruncated: base.historyTruncated,
    missing: new Set(base.missing),
    truncatedSegments: new Set(),
  };
  for (let guard = 0; guard < 500; guard += 1) {
    const candidate = candidateSnapshot(base, state, maxInputTokens);
    if (renderRequest(candidate).estimatedInputTokens <= maxInputTokens) {
      return renderedSnapshot(candidate);
    }
    if (!truncateNext(state))
      return renderedSnapshot(candidateSnapshot(base, state, maxInputTokens));
  }
  return renderedSnapshot(candidateSnapshot(base, state, maxInputTokens));
}
