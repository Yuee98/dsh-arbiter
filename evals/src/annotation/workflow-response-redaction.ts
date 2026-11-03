/** Exported placeholders are safe quotable evidence, even in another process. */
import { CredentialRedactor } from '../../../src/reviewer/credential-redactor.js';
import { CREDENTIAL_MARKER_SOURCE } from '../../../src/reviewer/credential-markers.js';
import { materialStrings } from './workflow-view.js';

export function responseRedactor(scope: string, request: unknown) {
  const redactor = new CredentialRedactor(scope);
  const replacements = new Map<string, string>();
  for (const text of materialStrings(request))
    for (const match of text.matchAll(
      new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu'),
    )) {
      const original = match[0];
      redactor.addKnown([original]);
      const protectedValue = redactor.sensitiveValue(original, 'credential');
      if (typeof protectedValue !== 'string')
        throw new Error('credential placeholder could not be protected');
      replacements.set(protectedValue, original);
    }
  const restoreText = (text: string): string => {
    for (const [protectedValue, original] of replacements)
      text = text.replaceAll(protectedValue, original);
    return text;
  };
  const restore = (value: unknown): unknown => {
    if (typeof value === 'string') return restoreText(value);
    if (Array.isArray(value)) return value.map(restore);
    if (value !== null && typeof value === 'object')
      return Object.fromEntries(
        Object.entries(value).map(([key, value]) => [
          restoreText(key),
          restore(value),
        ]),
      );
    return value;
  };
  return {
    text: (text: string) => restoreText(redactor.text(text)),
    value: (value: unknown) => restore(redactor.value(value)),
  };
}
