/** Sanitize audit copies, including schema literals; execution-owned inputs stay intact. */
import type { CallRecord } from './types.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import {
  copyArgumentsSchema,
  discoverSchemaCredentials,
} from './schema-redaction.js';
import { credentialRegistry } from '../reviewer/credential-registry.js';
import { retainedSnapshot, snapshotRedactor } from '../snapshot/redaction.js';
import { templateIdOf } from './metadata.js';
import {
  isPreparedReviewRequest,
  reviewRequestCopy,
  preparedScoreMode,
} from '../reviewer/prepared-request.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function attemptCopy(
  attempt: CallRecord['modelAttempts'][number],
  redactor: CredentialRedactor,
): CallRecord['modelAttempts'][number] {
  const scores = preparedScoreMode(attempt.request, redactor, attempt.backend);
  const request = reviewRequestCopy(attempt.request, redactor);
  const system =
    object(request) && typeof request['system'] === 'string'
      ? request['system']
      : null;
  const originalSystem =
    object(attempt.request) && typeof attempt.request['system'] === 'string'
      ? attempt.request['system']
      : null;
  const changedTemplate =
    attempt.templateId !== undefined &&
    originalSystem !== null &&
    system !== null &&
    system !== originalSystem &&
    attempt.templateId === templateIdOf(originalSystem);
  return {
    ...attempt,
    request,
    ...(!changedTemplate ? {} : { templateId: templateIdOf(system) }),
    responseText:
      attempt.responseText === null
        ? null
        : redactor.text(attempt.responseText, scores),
    parsed: redactor.value(attempt.parsed, scores),
    error: attempt.error === null ? null : redactor.text(attempt.error),
    usage: redactor.value(attempt.usage),
    normalizedUsage: redactor.value(attempt.normalizedUsage, true),
  };
}
export function redactCallRecord(
  db: DatabaseSync,
  record: CallRecord,
): CallRecord {
  const redactor =
    (record.snapshot === null
      ? undefined
      : snapshotRedactor(record.snapshot)) ??
    credentialRegistry(db, db.location())
      .context(record.sessionId, record.parentSession)
      .fork();
  // Schema literals can reveal a credential referenced without a label elsewhere.
  redactor.validate(record.argumentsSchema);
  redactor.discover([
    record.arguments,
    record.cwd,
    record.workspace,
    record.profile,
    record.usage,
    record.reason,
    record.effect,
    record.trace.map((stage) => [stage.reason, stage.ruleName]),
  ]);
  for (const attempt of record.modelAttempts) {
    const scores = preparedScoreMode(
      attempt.request,
      redactor,
      attempt.backend,
    );
    if (!isPreparedReviewRequest(attempt.request, redactor))
      redactor.discover(attempt.request, true);
    for (const material of [attempt.responseText, attempt.parsed])
      redactor.discover(material, scores);
    redactor.discover(attempt.error);
    redactor.discover([attempt.usage, attempt.normalizedUsage]);
  }
  if (
    record.snapshot !== null &&
    snapshotRedactor(record.snapshot) === undefined
  )
    redactor.discover(record.snapshot);
  // Complete schema-aware knowledge before retaining any projected column.
  discoverSchemaCredentials(record.argumentsSchema, redactor);
  const argumentsSchema = copyArgumentsSchema(record.argumentsSchema, redactor);
  return {
    ...record,
    cwd: redactor.text(record.cwd),
    workspace:
      record.workspace === null ? null : redactor.text(record.workspace),
    profile: record.profile === null ? null : redactor.text(record.profile),
    arguments: redactor.value(record.arguments),
    ...(record.argumentsSchema === undefined ? {} : { argumentsSchema }),
    reason: redactor.text(record.reason),
    effect: redactor.value(record.effect),
    trace: record.trace.map((stage) => ({
      ...stage,
      ...(stage.reason === undefined
        ? {}
        : { reason: redactor.text(stage.reason) }),
      ...(stage.ruleName === undefined
        ? {}
        : { ruleName: redactor.text(stage.ruleName) }),
    })),
    // Keep the historical send/budget, masking any newly recognized credentials
    // before persistence without reinterpreting typed protocol metadata.
    snapshot:
      record.snapshot === null
        ? null
        : retainedSnapshot(record.snapshot, redactor),
    modelAttempts: record.modelAttempts.map((attempt) =>
      attemptCopy(attempt, redactor),
    ),
    usage: redactor.value(record.usage),
  };
}
