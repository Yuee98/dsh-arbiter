import { canonicalJson } from './hash.js';
import type { AnnotationBinding } from './annotation-types.js';
/** Actual visible material/semantics, with conservative credential-value checking. */
export function sameAnnotationView(
  left: AnnotationBinding,
  right: AnnotationBinding,
): boolean {
  return (
    left.promptFingerprint === right.promptFingerprint &&
    canonicalJson(left.versions) === canonicalJson(right.versions) &&
    (!(left.credentials || right.credentials) ||
      left.inputHash === right.inputHash)
  );
}
