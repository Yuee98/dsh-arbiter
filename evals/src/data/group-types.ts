/** Versioned grouped sources. These are source records, never reviewer prompts or active gold. */
import type {
  BehaviourReference,
  CaseReviews,
  LabelTarget,
  LabelVersions,
  ModelOpinion,
  Provenance,
  ReviewCase,
  ReviewLabel,
  Split,
} from './types.js';
import type { Sourced } from './read.js';
import type { Finding } from './inspect.js';

export interface RecordCollection<T> {
  readonly schemaVersion: 'grouped-v1';
  readonly records: readonly T[];
}

export interface WorkflowSession {
  readonly sessionId: string;
  readonly parentSessionId?: string;
}

interface EventIdentity {
  readonly eventId: string;
  readonly sessionId: string;
  /** Host order within this session/path; gaps are legal. Never a wall clock. */
  readonly seq: number;
  readonly turnId: string | null;
  readonly time?: number;
  readonly branchId?: string;
}

export interface PendingAction {
  readonly callId: string;
  readonly tool: string;
  readonly arguments: unknown;
  readonly cwd?: string;
  readonly route: 'reviewer' | 'bypass' | 'ask';
}

export type WorkflowCall = EventIdentity &
  PendingAction & { readonly kind: 'call' };

export type ResultBody =
  | {
      readonly state: 'present';
      readonly content: unknown;
      readonly truncations?: readonly {
        readonly source: 'upstream' | 'collection';
        readonly note: string;
      }[];
    }
  | { readonly state: 'empty' }
  | {
      readonly state: 'unavailable';
      readonly reason: 'not-provided' | 'unreadable' | 'lost';
    }
  | {
      readonly state: 'omitted';
      readonly media: readonly {
        readonly type: string;
        readonly ref?: string;
        readonly note: string;
      }[];
    };

export type WorkflowEvent =
  | WorkflowCall
  | (EventIdentity & {
      readonly kind: 'message';
      readonly role: 'user' | 'assistant';
      readonly source: 'human' | 'agent' | 'parent-relay';
      readonly content: string;
      readonly replyToAskId?: string;
    })
  | (EventIdentity & {
      readonly kind: 'result';
      readonly callId: string;
      readonly status: 'success' | 'failure' | 'unknown';
      readonly body: ResultBody;
    })
  | (EventIdentity & {
      readonly kind: 'ask';
      readonly askId: string;
      readonly channel: 'agent' | 'approval';
      readonly question: string;
      readonly callId?: string;
    })
  | (EventIdentity & {
      readonly kind: 'answer';
      readonly askId: string;
      readonly content: string;
    })
  | (EventIdentity & {
      readonly kind: 'settlement';
      readonly callId: string;
      readonly outcome: 'allowed' | 'denied' | 'aborted' | 'failed';
    })
  | (EventIdentity & { readonly kind: 'checkpoint'; readonly content: string });

export interface SessionCutoff {
  readonly sessionId: string;
  /** null means a known empty prefix; availability is recorded separately. */
  readonly eventId: string | null;
}

export interface WorkflowBranch {
  readonly branchId: string;
  /** main is the built-in path. Branches only declare prefixes; no execution DSL. */
  readonly parentBranchId: string;
  readonly fork: readonly SessionCutoff[];
}

export interface WorkflowPoint {
  readonly pointId: string;
  /** Stable identity only. Actual rendered-view applicability is checked downstream. */
  readonly primaryViewId: string;
  readonly sessionId: string;
  readonly branchId?: string;
  readonly cutoffEventId: string | null;
  /** Refer to a recorded call, or carry a pending call not yet appended by the host. */
  readonly pending: { readonly callEventId: string } | PendingAction;
  /** A separate read at review preparation, possibly after the call was logged. */
  readonly parentRead?: {
    readonly sessionId: string;
    readonly cutoffEventId: string | null;
    readonly status: 'complete' | 'partial' | 'unavailable';
  };
  readonly predecessorPointId?: string;
}

export interface Workflow {
  readonly rootId: string;
  readonly lineageId?: string;
  readonly provenance: Provenance & {
    readonly sourceId?: string;
    readonly captureMethod:
      'manual' | 'programmatic' | 'isolated-host' | 'user-artifact';
  };
  readonly tags?: readonly string[];
  /** Author-supplied scenario metadata, not original human authorization. */
  readonly task: string;
  readonly environment?: {
    readonly cwd?: string;
    readonly description?: string;
  };
  readonly sessions: readonly WorkflowSession[];
  readonly branches?: readonly WorkflowBranch[];
  readonly events: readonly WorkflowEvent[];
  readonly points: readonly WorkflowPoint[];
  readonly relations?: readonly {
    readonly relationId: string;
    readonly kind: 'controlled' | 'natural';
    readonly pointIds: readonly string[];
    readonly description: string;
  }[];
  readonly notes?: string;
}

export interface WorkflowLabel {
  readonly referenceId: string;
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly source:
    'human' | 'human-inherited' | 'model-consensus' | 'unresolved';
  readonly humanConfirmed: boolean;
  readonly scoringEligible: boolean;
  readonly versions: LabelVersions;
  readonly batchId: string;
  readonly supportingOpinionIds: readonly string[];
  readonly target: LabelTarget;
  readonly notes?: string;
}

export interface WorkflowOpinion {
  readonly rootId: string;
  readonly pointId: string;
  readonly viewId: string;
  readonly batchId: string;
  readonly outcome: 'answered' | 'partial' | 'failed' | 'missing';
  readonly opinion: ModelOpinion;
  /** Independent answer, never inferred from the scores/matrix. */
  readonly independentBehaviour: BehaviourReference | null;
  readonly responseRef: string | null;
  readonly rationale: string | null;
  readonly evidence: readonly {
    readonly kind: 'material-quote' | 'link' | 'note';
    readonly ref: string;
    readonly note?: string;
  }[];
  readonly error?: string;
}

export interface GroupSelection {
  readonly split?: Split | 'all';
  readonly group?: string;
  readonly contentSet?: 'legacy-v1' | 'workflows-v1';
  /** Safe default physically avoids opening labels/opinions as well as authoring. */
  readonly references?: boolean;
}

export interface DataGroup {
  readonly split: Split;
  readonly group: string;
  readonly contentSet: 'legacy-v1' | 'workflows-v1';
  readonly workflows: readonly Sourced<Workflow>[];
  readonly cases: readonly Sourced<ReviewCase>[];
  readonly labels: readonly Sourced<WorkflowLabel | ReviewLabel>[];
  readonly opinions: readonly Sourced<WorkflowOpinion | CaseReviews>[];
}

export interface GroupedDataset {
  readonly groups: readonly DataGroup[];
  readonly problems: readonly Finding[];
  readonly findings: readonly Finding[];
  readonly scope: {
    readonly splits: readonly Split[];
    readonly group: string | null;
    readonly contentSet: string | null;
  };
}
