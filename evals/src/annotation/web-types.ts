import type { HumanState } from '../data/annotation-types.js';
import type { BehaviourReference } from '../data/types.js';

export interface WebForm {
  readonly pairs: string;
  readonly behaviour: BehaviourReference | '';
  readonly rationale: string;
  readonly evidence: string;
  readonly author: string;
  readonly state: Exclude<HumanState, 'draft'>;
}
export const EMPTY_FORM: WebForm = {
  pairs: '',
  behaviour: '',
  rationale: '',
  evidence: '',
  author: '',
  state: 'confirmed',
};
export interface WebPointSummary {
  readonly token: string;
  readonly workflow: number;
  readonly position: number;
  readonly status: HumanState | 'unopened' | 'preparation-failed';
  readonly sampled: boolean;
}
export interface WebPoint extends WebPointSummary {
  readonly publicationPending: boolean;
  readonly revision: number;
  readonly form: WebForm;
  readonly request: unknown;
  readonly changedLines: readonly number[];
  readonly hasPredecessor: boolean;
  readonly preparation: 'ready' | 'preparation-failed';
  readonly error: string | null;
  readonly exposed: boolean;
}
export interface WebOpinion {
  readonly id: string;
  readonly model: string;
  readonly rawResponse: string | null;
  readonly rationale: string | null;
  readonly evidence: string;
  readonly pairs: string;
  readonly behaviour: BehaviourReference | '';
  readonly complete: boolean;
}
export interface WebBootstrap {
  readonly mode: 'blind' | 'assisted';
  readonly points: readonly WebPointSummary[];
  readonly current: string | null;
  readonly risk: readonly {
    readonly score: number;
    readonly criterion: string;
  }[];
  readonly authorization: readonly {
    readonly score: number;
    readonly criterion: string;
  }[];
}
export interface WebMutation {
  readonly token: string;
  readonly revision: number;
  readonly form: WebForm;
  readonly sampled: boolean;
}
export interface WebTransport {
  bootstrap(): Promise<WebBootstrap>;
  point(token: string): Promise<WebPoint>;
  save(value: WebMutation): Promise<WebPoint>;
  confirm(value: WebMutation): Promise<WebPoint>;
  opinions(token: string): Promise<readonly WebOpinion[]>;
  rebase(token: string, revision: number): Promise<WebPoint>;
}
