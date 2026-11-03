/** Explicit URL authentication is vocabulary evidence, never a public configuration view. */
import type { RunTarget } from '../run/types.js';

function decoded(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
export function targetCredentialEvidence(
  targets: readonly RunTarget[],
): unknown {
  return [
    targets,
    ...targets.flatMap((target) => {
      if (target.decision === null) return [];
      try {
        const url = new URL(target.decision.url);
        return [
          { token: url.username, password: url.password },
          { token: decoded(url.username), password: decoded(url.password) },
          ...[...url.searchParams.entries()].map(([key, value]) => ({
            [key]: value,
          })),
        ];
      } catch {
        // An invalid URL stays private; existing text recognition still receives the saved target.
        return [];
      }
    }),
  ];
}
