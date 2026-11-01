/** Compatibility entry points, all backed by the shared credential policy. */
import { CredentialRedactor } from './credential-redactor.js';

export function redact(text: string, secrets: readonly string[]): string {
  return new CredentialRedactor('reviewer-answer', secrets).knownText(text);
}

export function redactAuthHeaders(text: string): string {
  return new CredentialRedactor('reviewer-answer').text(text, true);
}

export function redactValue(
  value: unknown,
  secrets: readonly string[],
): unknown {
  return new CredentialRedactor('reviewer-answer', secrets).value(value, true);
}
