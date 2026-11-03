import type { EvaluationReport } from '../metrics/types.js';
import type { GitObservation } from '../run/workflow-types.js';

export interface PublicationCell {
  readonly cellId: string;
  readonly indexStatus: string;
  readonly recordStatus: string | null;
  readonly recordPresent: boolean;
  readonly recordPath: string | null;
  readonly mismatch: boolean;
  readonly reason: string | null;
}
export interface ReportPublication {
  readonly generation: 'rendered';
  readonly qualityAcceptance: {
    readonly status: 'not-assessed';
    readonly reason: string;
  };
  readonly testedCode: GitObservation;
  readonly testedSource: GitObservation;
  readonly archiveCommit: 'tracked-by-git-history';
  readonly runDirectory: string;
  readonly evidenceAccess: 'local-only';
  readonly planPath: string;
  readonly indexPath: string;
  readonly datasetPath: string | null;
  readonly references: readonly string[];
  readonly scope: {
    readonly split: string;
    readonly groups: readonly string[];
    readonly plannedCells: number;
  };
  readonly context: {
    readonly maxInputTokens: number;
    readonly targetInputTokens: number | null;
  };
  readonly consistency: {
    readonly indexReliable: boolean;
    readonly provenanceConflict: boolean;
    readonly cells: readonly PublicationCell[];
  };
}
/** Optional only for historical callers that render an already built report directly. */
export interface PublishedReport extends EvaluationReport {
  readonly publication?: ReportPublication;
}
