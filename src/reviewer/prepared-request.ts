/** Ownership proof for the frozen request rendered from a sanitized snapshot.
 * A serialized lookalike has no binding. Nothing here is persisted or embedded.
 */
import type { CredentialRedactor } from './credential-redactor.js';
import type { CredentialScoreMode } from './credential-scores.js';
const PREPARED = new WeakMap<
  object,
  {
    readonly context: CredentialRedactor;
    readonly revision: number;
    readonly copy: () => unknown;
    readonly scores: CredentialScoreMode;
  }
>();
export function bindPreparedReviewRequest(
  request: object,
  context: CredentialRedactor,
  copy: () => unknown = () => context.value(request, true),
  source: object = request,
  scores?: CredentialScoreMode,
): void {
  const previous = PREPARED.get(source);
  PREPARED.set(request, {
    context,
    revision:
      previous?.context === context ? previous.revision : context.revision,
    copy,
    scores: scores ?? (previous?.context === context ? previous.scores : true),
  });
}
export function preparedScoreMode(
  request: unknown,
  context: CredentialRedactor,
  fallback: CredentialScoreMode = true,
): CredentialScoreMode {
  if (request === null || typeof request !== 'object') return fallback;
  const prepared = PREPARED.get(request);
  return prepared?.context === context ? prepared.scores : fallback;
}
export function isPreparedReviewRequest(
  request: unknown,
  context: CredentialRedactor,
): boolean {
  return (
    request !== null &&
    typeof request === 'object' &&
    PREPARED.get(request)?.context === context
  );
}
export function reviewRequestCopy(
  request: unknown,
  context: CredentialRedactor,
): unknown {
  if (request === null || typeof request !== 'object')
    return context.value(request, true);
  const prepared = PREPARED.get(request);
  if (prepared?.context !== context) return context.value(request, true);
  return prepared.revision === context.revision ? request : prepared.copy();
}
