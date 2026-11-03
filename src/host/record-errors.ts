/** Diagnostic state is bounded independently of durable history. */
export function rememberRecordError(
  errors: Map<string, string>,
  callId: string,
  reason: string,
): void {
  errors.set(callId, reason);
  while (errors.size > 200) {
    const oldest = errors.keys().next().value;
    if (oldest === undefined) break;
    errors.delete(oldest);
  }
}
