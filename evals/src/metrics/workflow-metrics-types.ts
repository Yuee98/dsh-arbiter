import type { Workflow } from '../data/group-types.js';
import type { Fraction } from './quality-types.js';

/** Source declarations, not evidence of candidate execution. */
export interface WorkflowMetricSource {
  readonly workflow: Pick<Workflow, 'rootId' | 'points' | 'relations'>;
  readonly group: string;
  readonly split: string;
  readonly path: string;
}
export interface TrajectoryRow {
  readonly rootId: string;
  readonly branchId: string;
  readonly terminalPointId: string;
  readonly targetId: string;
  readonly protocol: string;
  readonly repeat: number;
  readonly status: 'satisfied' | 'violated' | 'incomplete' | 'partial-scope';
  readonly firstObservedDeviation: string | null;
  readonly firstUnassessable: string | null;
  readonly nodes: readonly {
    readonly pointId: string;
    readonly viewId: string;
    readonly result: string;
  }[];
}
export interface TrajectorySection {
  readonly evidence: 'fixed-source-prefixes';
  readonly selected: number;
  readonly completeScope: number;
  readonly assessable: number;
  readonly satisfied: number;
  readonly violated: number;
  readonly incomplete: number;
  readonly partialScope: number;
  readonly agreement: Fraction;
  readonly actualContinuation: 'not-observed';
  readonly rows: readonly TrajectoryRow[];
}
export interface RelationField {
  readonly leftPointId: string;
  readonly rightPointId: string;
  readonly field: 'risk' | 'authorization';
  readonly expectedDelta: number | null;
  readonly observedDelta: number | null;
  readonly status: 'satisfied' | 'violated' | 'unassessable' | 'descriptive';
  readonly violationMagnitude: number | null;
  readonly tied: boolean;
}
export interface RelationRow {
  readonly rootId: string;
  readonly relationId: string;
  readonly kind: 'controlled' | 'natural';
  readonly targetId: string;
  readonly protocol: string;
  readonly repeat: number;
  readonly status: RelationField['status'];
  readonly fields: readonly RelationField[];
}
export interface RelationSection {
  readonly fields: Readonly<
    Record<
      RelationField['field'],
      {
        readonly planned: number;
        readonly assessable: number;
        readonly satisfied: number;
        readonly violated: number;
        readonly unassessable: number;
        readonly descriptive: number;
        readonly agreement: Fraction;
      }
    >
  >;
  readonly selected: number;
  readonly determinate: number;
  readonly satisfied: number;
  readonly violated: number;
  readonly unassessable: number;
  readonly descriptive: number;
  readonly agreement: Fraction;
  readonly rows: readonly RelationRow[];
}
