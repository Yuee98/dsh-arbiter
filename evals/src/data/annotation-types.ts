/** Optional workflow annotation metadata; source/point and historical records keep their format. */
import type { BehaviourReference, LabelVersions, ScorePair } from './types.js';

export interface AnnotationBinding {
  readonly inputHash: string;
  readonly promptFingerprint: string;
  readonly credentials: boolean;
  readonly versions: LabelVersions;
}
export interface AnnotationContext {
  readonly protocol: 'chat' | 'decision';
  readonly targetInputTokens: number;
  readonly maxInputTokens: number;
  readonly customRules: string;
  readonly projectRules: string | null;
}
export interface OpinionAnnotation {
  readonly binding: AnnotationBinding;
  /** Canonical model identity, shared across versions, proxies and batches. */
  readonly modelKey: string;
  readonly aliases: readonly string[];
  readonly registration: boolean;
  readonly rawResponse: string | null;
  readonly parsed: unknown;
  readonly returned: unknown;
  readonly parameters: unknown;
  readonly pairs: readonly ScorePair[] | null;
  readonly conflicts: readonly string[];
  readonly problems: readonly string[];
  readonly complete: boolean;
  readonly recordedOrder: number;
  /** Internal retry equality over the received payload, never a public identity. */
  readonly responseHash: string;
  readonly sourceCommit: string | null;
  readonly context: AnnotationContext;
}
export type HumanState =
  'draft' | 'confirmed' | 'disputed' | 'undecidable' | 'needs-review';
export interface LabelAnnotation {
  readonly binding: AnnotationBinding;
  readonly humanState?: HumanState;
  readonly inheritedFrom?: string;
}
export interface IndependentAnswer {
  readonly pairs: readonly ScorePair[] | null;
  readonly behaviourReference: BehaviourReference | null;
  readonly rationale: string;
  /** Exact quotes from the actual rendered material, never hidden source IDs. */
  readonly evidence: readonly string[];
  readonly conflicts: readonly string[];
}
