/** Shared view binding. Callers must first establish which actual material they hold. */
import type { ReviewPackage } from '../../../src/reviewer/package.js';
import { CREDENTIAL_MARKER_SOURCE } from '../../../src/reviewer/credential-markers.js';
import type { CaseMaterial } from '../run/material.js';
import type { RunProtocol } from '../run/types.js';
import type { AnnotationBinding } from '../data/annotation-types.js';
import type { LabelVersions } from '../data/types.js';
import { canonicalJson, digestOf } from '../data/hash.js';

/** Preserve kind and equality relationships, while ignoring process-random signatures. */
export function comparableAnnotationRequest(request: unknown): {
  text: string;
  credentials: boolean;
} {
  const seen = new Map<string, number>();
  const wire =
    request !== null && typeof request === 'object'
      ? Object.fromEntries(
          Object.entries(request).filter(
            ([key]) => key !== 'estimatedInputTokens',
          ),
        )
      : request;
  const text = canonicalJson(wire).replace(
    new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu'),
    (marker) => {
      let index = seen.get(marker);
      if (index === undefined) {
        index = seen.size;
        seen.set(marker, index);
      }
      return marker.replace(/[a-f0-9]{64}/u, String(index));
    },
  );
  return { text, credentials: seen.size > 0 };
}
export function annotationBindingOf(parts: {
  readonly material: Pick<CaseMaterial, 'snapshot' | 'material'>;
  readonly protocol: RunProtocol;
  readonly pkg: ReviewPackage;
  readonly versions: LabelVersions;
}): AnnotationBinding {
  const comparable = {
    ...parts.material.snapshot,
    configRevision: 'annotation',
  };
  const stable = comparableAnnotationRequest(
    parts.protocol === 'chat'
      ? parts.pkg.renderChat(comparable)
      : parts.pkg.renderDecision(comparable),
  );
  return {
    inputHash: parts.material.material.inputHash,
    promptFingerprint: digestOf(stable.text),
    credentials: stable.credentials,
    versions: { ...parts.versions },
  };
}
