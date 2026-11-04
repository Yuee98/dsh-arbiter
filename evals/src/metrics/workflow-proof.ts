/** Qualify a reconstructed request before it can acquire a frozen reference. */
import { canonicalJson } from '../data/hash.js';
import { comparableAnnotationRequest } from '../annotation/workflow-binding.js';
import type { sourceMaterial } from '../run/source.js';
import type { CellRecord, RunProtocol } from '../run/types.js';

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
/** Compare the visible initial payload, retaining credential kind and equality relationships. */
function retainedRequestMatches(
  actual: unknown,
  reconstructed: unknown,
  protocol: RunProtocol,
): boolean {
  const sent = object(actual),
    rebuilt = object(reconstructed);
  if (sent === null || rebuilt === null) return false;
  const expected =
    protocol === 'chat'
      ? {
          system: rebuilt['system'],
          messages: [
            {
              role: 'user',
              content: [{ type: 'text', text: rebuilt['user'] }],
            },
          ],
        }
      : { state: rebuilt['state'], questions: rebuilt['questions'] };
  const body = protocol === 'decision' ? (object(sent['input']) ?? sent) : sent;
  const visible =
    protocol === 'chat'
      ? { system: body['system'], messages: body['messages'] }
      : { state: body['state'], questions: body['questions'] };
  return (
    comparableAnnotationRequest(expected).text ===
    comparableAnnotationRequest(visible).text
  );
}
export function workflowMaterialProblems(parts: {
  readonly material: Awaited<ReturnType<typeof sourceMaterial>>;
  readonly record: CellRecord | null;
  readonly protocol: RunProtocol;
  readonly credentials: boolean;
}): readonly string[] {
  const record = parts.record;
  // Recordless/unsupported planned cells have no submitted material. Their reference
  // is for the verified frozen plan, never evidence of a request or host continuation.
  if (
    record === null ||
    (record.status === 'unsupported' && record.material === null)
  )
    return [];
  if (record.material === null) return ['record-material-missing'];
  const { promptFingerprint: before, ...saved } = record.material;
  const { promptFingerprint: after, ...rebuilt } = parts.material.material;
  if (
    canonicalJson(saved) !== canonicalJson(rebuilt) ||
    record.case.inputHash !== rebuilt.inputHash
  )
    return ['record-material-drift'];
  const initial = record.attempts.find((attempt) => attempt.kind === 'initial');
  if (
    initial !== undefined &&
    !retainedRequestMatches(
      initial.request,
      parts.material.request,
      parts.protocol,
    )
  )
    return ['record-request-drift'];
  if (before === after) return [];
  // Process-local credential signatures may change, while visible material does not.
  // A retained initial request is required to establish their relationships.
  return parts.credentials && initial !== undefined
    ? []
    : ['record-request-unverified'];
}
