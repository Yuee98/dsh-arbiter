/** Process-local authentication prevents attacker-supplied marker lookalikes from bypassing masking. */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
const KEY = randomBytes(32);
export const CREDENTIAL_MARKER_SOURCE = String.raw`\[redacted:v1:(?:credential|password|token|cookie|private-key):[a-f0-9]{64}\]`;
function signature(kind: string, identity: string): string {
  return createHmac('sha256', KEY)
    .update(JSON.stringify(['marker', kind, identity]))
    .digest('hex')
    .slice(0, 32);
}
export function credentialIdentity(
  scope: string,
  value: string,
  namespace = 'credential',
): string {
  return createHmac('sha256', KEY)
    .update(JSON.stringify([namespace, scope, value]))
    .digest('hex')
    .slice(0, 32);
}
export function credentialMarker(kind: string, identity: string): string {
  return `[redacted:v1:${kind}:${identity}${signature(kind, identity)}]`;
}
export function verifiedCredentialMarker(value: string): boolean {
  const match =
    /^\[redacted:v1:(credential|password|token|cookie|private-key):([a-f0-9]{32})([a-f0-9]{32})\]$/u.exec(
      value,
    );
  if (match === null) return false;
  return timingSafeEqual(
    Buffer.from(match[3] ?? '', 'hex'),
    Buffer.from(signature(match[1] ?? '', match[2] ?? ''), 'hex'),
  );
}
