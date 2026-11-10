import type {
  AnnotationBinding,
  AnnotationContext,
  HumanState,
} from '../data/annotation-types.js';
import type { WorkflowLabel, WorkflowOpinion } from '../data/group-types.js';
import type { LabelTarget, ModelIdentity, Split } from '../data/types.js';

export interface RegisteredModel {
  readonly modelKey: string;
  readonly aliases: readonly string[];
  readonly model: ModelIdentity;
  readonly parameters: unknown;
}
export interface AnnotationPoint {
  readonly questionId: string;
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly modelReferenceId: string;
  readonly humanReferenceId: string;
  readonly binding: AnnotationBinding | null;
  readonly request: unknown;
  readonly error: string | null;
  readonly registrations: readonly {
    readonly modelKey: string;
    readonly reviewId: string;
  }[];
}
export interface WorkflowBatch {
  readonly purpose?: 'human' | 'prepared';
  readonly batchVersion: 'workflow-annotation-v1';
  readonly batchId: string;
  readonly dataset: string;
  readonly split: Split;
  readonly group: string;
  readonly createdAt: string;
  readonly sourceCommit: string | null;
  readonly sourceDirty: boolean | null;
  /** Private local batch material; never part of a model question or grouped record. */
  readonly retryKey?: string;
  readonly context: AnnotationContext;
  readonly models: readonly RegisteredModel[];
  readonly points: readonly AnnotationPoint[];
  readonly labels: readonly WorkflowLabel[];
  readonly opinions: readonly WorkflowOpinion[];
}
export interface ReturnedResponse {
  readonly responseId: string;
  readonly questionId: string;
  readonly modelKey: string;
  readonly rawResponse: string | null;
  readonly error: string | null;
  readonly metadata?: unknown;
}
export interface ReturnedBatch {
  readonly batchId: string;
  readonly responses: readonly ReturnedResponse[];
}
export interface HumanFill {
  readonly questionId: string;
  readonly state: HumanState;
  readonly target: LabelTarget;
}
export interface HumanBatch {
  readonly batchId: string;
  readonly decisions: readonly HumanFill[];
}
