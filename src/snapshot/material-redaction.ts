/** Project diagnostics after shared discovery; keep source/status facts typed. */
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import type { CompletenessInput } from './completeness.js';

export function redactCompletenessInput(
  input: Omit<CompletenessInput, 'trimmed'>,
  redactor: CredentialRedactor,
): Omit<CompletenessInput, 'trimmed'> {
  const text = (value: string) => redactor.text(value);
  const nullable = (value: string | null) =>
    value === null ? null : text(value);
  return {
    ...input,
    ...(input.sourceObservations === undefined
      ? {}
      : {
          sourceObservations: input.sourceObservations.map((item) => ({
            ...item,
            reason: text(item.reason),
          })),
        }),
    sessionError: nullable(input.sessionError),
    parentError: nullable(input.parentError),
    projectRules: {
      ...input.projectRules,
      // Classification belongs to the source observation, before its text changes.
      unreadable:
        input.projectRules.unreadable ??
        input.projectRules.missing?.includes('could not be read') ??
        false,
      missing: nullable(input.projectRules.missing),
    },
    sessionRecordGap: nullable(input.sessionRecordGap),
    historyGap: input.historyGap.map(text),
    windowGap: nullable(input.windowGap),
    protectedEvidenceDropped: input.protectedEvidenceDropped.map((item) => ({
      ...item,
      reason: text(item.reason),
    })),
  };
}
