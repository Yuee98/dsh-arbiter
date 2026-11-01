/** Ownership proof for the frozen request rendered from a sanitized snapshot.
 * A serialized lookalike has no binding. Nothing here is persisted or embedded.
 */
import type { CredentialRedactor } from './credential-redactor.js';
const PREPARED = new WeakMap<
  object,
  {
    readonly context: CredentialRedactor;
    readonly revision: number;
    readonly copy: () => unknown;
  }
>();
export function bindPreparedReviewRequest(
  request: object,
  context: CredentialRedactor,
  copy: () => unknown = () => context.value(request, true),
  source: object = request,
): void {
  const previous = PREPARED.get(source);
  PREPARED.set(request, {
    context,
    revision:
      previous?.context === context ? previous.revision : context.revision,
    copy,
  });
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
