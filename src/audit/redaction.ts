/** Sanitize audit copies, including schema literals; execution-owned inputs stay intact. */
import type { CallRecord } from './types.js';
import type { DatabaseSync } from 'node:sqlite';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import {
  credentialKind,
  type CredentialKind,
} from '../reviewer/credential-fields.js';
import { credentialRegistry } from '../reviewer/credential-registry.js';
import { redactSnapshot, snapshotRedactor } from '../snapshot/redaction.js';
import { templateIdOf } from './metadata.js';

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function schemaCopy(
  value: unknown,
  redactor: CredentialRedactor,
  kind: CredentialKind | null = null,
  state = { active: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64)
    throw new Error('credential schema material limit exceeded');
  if (value === null || typeof value !== 'object') return redactor.value(value);
  if (state.active.has(value))
    throw new Error('credential schema material could not be safely processed');
  state.active.add(value);
  try {
    if (Array.isArray(value))
      return value.map((item: unknown) =>
        schemaCopy(item, redactor, kind, state, depth + 1),
      );
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => {
        if (key === 'properties' && object(item))
          return [
            key,
            Object.fromEntries(
              Object.entries(item).map(([name, schema]) => [
                redactor.knownText(name),
                schemaCopy(
                  schema,
                  redactor,
                  credentialKind(name),
                  state,
                  depth + 1,
                ),
              ]),
            ),
          ];
        if (
          kind !== null &&
          ['default', 'const', 'enum', 'examples'].includes(key)
        )
          return [key, redactor.sensitiveValue(item, kind)];
        return [
          redactor.knownText(key),
          schemaCopy(item, redactor, kind, state, depth + 1),
        ];
      }),
    );
  } finally {
    state.active.delete(value);
  }
}
function attemptCopy(
  attempt: CallRecord['modelAttempts'][number],
  redactor: CredentialRedactor,
): CallRecord['modelAttempts'][number] {
  const request = redactor.value(attempt.request, true);
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
        : redactor.text(attempt.responseText, true),
    parsed: redactor.value(attempt.parsed, true),
    error: attempt.error === null ? null : redactor.text(attempt.error, true),
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
  redactor.discover(record.argumentsSchema);
  const argumentsSchema = schemaCopy(record.argumentsSchema, redactor);
  redactor.discover([
    record.arguments,
    record.reason,
    record.effect,
    record.trace.map((stage) => [stage.reason, stage.ruleName]),
  ]);
  redactor.discover(
    record.modelAttempts.map((attempt) => [
      attempt.request,
      attempt.responseText,
      attempt.parsed,
      attempt.error,
      attempt.usage,
    ]),
    true,
  );
  if (
    record.snapshot !== null &&
    snapshotRedactor(record.snapshot) === undefined
  )
    redactor.discover(record.snapshot);
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
    // A prepared snapshot is the frozen wire view, not a new post-response projection.
    snapshot:
      record.snapshot === null ||
      snapshotRedactor(record.snapshot) !== undefined
        ? record.snapshot
        : redactSnapshot(record.snapshot, redactor),
    modelAttempts: record.modelAttempts.map((attempt) =>
      attemptCopy(attempt, redactor),
    ),
    usage: redactor.value(record.usage),
  };
}
