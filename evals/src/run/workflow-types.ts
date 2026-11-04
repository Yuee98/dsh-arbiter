import type { RunPlan } from './types.js';

export interface WorkflowPointSelection {
  readonly group: string;
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly lineageId?: string;
}

export interface WorkflowIdentity extends WorkflowPointSelection {
  readonly lineageId: string;
}

export interface WorkflowSelection {
  readonly contentSet: 'workflows-v1';
  readonly points: readonly WorkflowPointSelection[];
  readonly input: {
    readonly customRules: string;
    readonly projectRules:
      | { readonly kind: 'disabled' }
      | { readonly kind: 'provided'; readonly text: string };
  };
}

/** One resource allowance has exactly one immutable run directory. */
export interface WorkflowResource {
  readonly runDirectory: string;
  readonly maxAttempts: number;
  readonly maxEstimatedInputTokens: number;
}

export interface GitObservation {
  readonly root: string | null;
  readonly revision: string | null;
  readonly dirty: boolean | null;
  readonly reason: string | null;
}

export interface WorkflowExecution {
  readonly config: unknown;
  readonly configRevision: string;
  readonly codeGit: GitObservation;
  readonly sourceGit: GitObservation;
}

export function sourceKeys(plan: RunPlan): readonly string[] {
  return (
    plan.workflow?.points.map((point) => point.viewId) ?? plan.caseIds ?? []
  );
}
