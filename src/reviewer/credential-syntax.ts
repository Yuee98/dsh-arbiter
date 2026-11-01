/** Closed quotes take precedence; an unclosed credential consumes its remaining logical input. */
export const QUOTED_CREDENTIAL_VALUE = String.raw`(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|\x60(?:\\.|[^\x60\\])*\x60|"(?:\\.|[^"\\])*\\?$|'(?:\\.|[^'\\])*\\?$|\x60(?:\\.|[^\x60\\])*\\?$)`;

export interface CredentialValueSpan {
  readonly start: number;
  readonly end: number;
  readonly kind: string;
}

export function credentialValueEnd(
  text: string,
  fieldStart: number,
  start: number,
  end: number,
): number {
  if (
    !['?', '&'].includes(text[fieldStart - 1] ?? '') ||
    ['"', "'", '`'].includes(text[start] ?? '')
  )
    return end;
  const suffix = text.slice(start, end).search(/[&#]/u);
  return suffix < 0 ? end : start + suffix;
}
