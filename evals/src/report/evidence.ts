/** Stored bodies need source/privacy admission before the shared credential projection. */
import { canonicalJson } from '../data/hash.js';
import { inputHashOf } from '../data/eligibility.js';
import type { Observation } from '../metrics/observe.js';
import type { EvaluationReport } from '../metrics/types.js';
import { effectiveWorkflowConfig } from '../run/source.js';
import type { CellRecord, RunAttemptKind } from '../run/types.js';

export interface ReportAttemptEvidence {
  readonly attempt: number;
  readonly kind: RunAttemptKind;
  readonly sent: boolean;
  readonly requestText: string | null;
  readonly responseText: string | null;
  readonly errorText: string | null;
}

export interface ReportCellEvidence {
  readonly cellId: string;
  /** A closed report-owned value, never a status copied from arbitrary request JSON. */
  readonly status:
    | 'published'
    | 'omitted-private-context'
    | 'unverified-context'
    | 'no-record';
  readonly materialText: string | null;
  readonly attempts: readonly ReportAttemptEvidence[];
}

function accessOf(
  observation: Observation,
  record: CellRecord,
): ReportCellEvidence['status'] {
  const { artifact } = observation;
  const workflow = artifact.plan.workflow;
  if (workflow !== undefined) {
    if (
      workflow.input.customRules !== '' ||
      workflow.input.projectRules.kind !== 'disabled'
    )
      return 'omitted-private-context';
    const saved = artifact.index.workflowExecution;
    const facts = observation.workflowCells?.get(record.cellId)?.caseFacts;
    if (
      saved === undefined ||
      facts?.source !== 'dataset' ||
      facts.conflictsWithDataset ||
      canonicalJson(saved.config) !==
        canonicalJson(effectiveWorkflowConfig(artifact.plan))
    )
      return 'unverified-context';
    return 'published';
  }
  // The inspected input is already in memory. Never reopen a newer case to invent
  // privacy provenance for a stored request whose source has disappeared or changed.
  const matches = observation.dataset.inspection?.cases.filter(
    (entry) => entry.document.caseId === record.case.caseId,
  );
  const input = matches?.length === 1 ? matches[0]?.document.input : undefined;
  if (input === undefined) return 'unverified-context';
  if (
    input.policy.customRules !== '' ||
    (input.policy.projectRules !== null && input.policy.projectRules !== '')
  )
    return 'omitted-private-context';
  const hash = inputHashOf(input);
  return hash === record.case.inputHash &&
    hash === record.material?.inputHash &&
    artifact.index.workflowExecution === undefined
    ? 'published'
    : 'unverified-context';
}

function storedText(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value;
  return JSON.stringify(value, null, 2);
}

export function reportEvidence(
  report: EvaluationReport,
  observation: Observation,
): readonly ReportCellEvidence[] {
  return report.examples.map((example) => {
    const record = observation.records.get(example.cellId);
    if (record === undefined)
      return {
        cellId: example.cellId,
        status: 'no-record',
        materialText: null,
        attempts: [],
      };
    const status = accessOf(observation, record);
    const publish = status === 'published';
    return {
      cellId: example.cellId,
      status,
      materialText: publish ? storedText(record.material) : null,
      attempts: record.attempts.map((attempt) => ({
        attempt: attempt.attempt,
        kind: attempt.kind,
        sent: attempt.sent !== false,
        requestText: publish ? storedText(attempt.request) : null,
        responseText: publish ? attempt.responseText : null,
        errorText: publish ? attempt.error : null,
      })),
    };
  });
}
