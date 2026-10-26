/**
 * The review-input view of a stored snapshot.
 *
 * A snapshot is the one immutable record of what the review was given, so the
 * detail shows it rather than re-reading the session: the evidence and materials
 * below are exactly what the reviewer saw, including the truncation and missing
 * facts it was told about. When no snapshot was stored (a rule short-circuit) the
 * lists are empty, which is not the same as a snapshot that lost its contents.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function arrayOf(value: unknown): readonly unknown[] {
  return Array.isArray(value) ? (value as readonly unknown[]) : [];
}

function stringList(value: unknown): readonly string[] {
  return arrayOf(value).filter(
    (item): item is string => typeof item === 'string',
  );
}

export interface SnapshotBasis {
  readonly evidence: readonly unknown[];
  readonly materials: readonly unknown[];
  readonly evidenceTruncated: boolean;
  readonly missing: readonly string[];
  readonly historyStatus: unknown;
}

/**
 * Read the aspects of a snapshot the detail needs, tolerating an absent or
 * unrecognized value.
 *
 * The snapshot's `version` is checked: a structure this build cannot interpret
 * is reported through the caller's missing codes instead of being projected into
 * today's fields, which would present a shape nobody wrote.
 */
export function snapshotBasis(snapshot: unknown): SnapshotBasis {
  const empty: SnapshotBasis = {
    evidence: [],
    materials: [],
    evidenceTruncated: false,
    missing: [],
    historyStatus: null,
  };
  if (!isRecord(snapshot)) return empty;
  if (snapshot['version'] !== 1) return empty;
  return {
    evidence: arrayOf(snapshot['evidence']),
    materials: arrayOf(snapshot['materials']),
    evidenceTruncated: snapshot['evidenceTruncated'] === true,
    missing: stringList(snapshot['missing']),
    historyStatus: isRecord(snapshot['historyStatus'])
      ? snapshot['historyStatus']
      : null,
  };
}
