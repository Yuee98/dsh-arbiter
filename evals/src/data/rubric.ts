/**
 * The rubric snapshot the dataset is labelled against.
 *
 * A label's meaning depends on the rubric that produced it, so the bands are
 * committed here as data rather than left implicit in a git history. Two checks
 * keep the snapshot honest:
 *
 *   - the bands must equal the shared review contract's bands, which is a hard
 *     failure: two copies of a scale drift, and a drifted copy grades different
 *     things with the same number;
 *   - the recorded document digest is compared with the rubric document itself and
 *     reported as a finding when it moved, so a wording-only edit does not break a
 *     build but a silent rewrite does get seen.
 */

import {
  AUTHORIZATION_BANDS,
  RISK_BANDS,
} from '../../../src/review-contract/index.js';
import type { RubricBand } from '../../../src/review-contract/index.js';

import { sha256Text } from './hash.js';
import type { RubricSnapshot } from './types.js';

/** What the snapshot directory holds, checked against the live contract. */
export interface RubricCheck {
  readonly snapshot: RubricSnapshot;
  readonly problems: readonly string[];
  readonly findings: readonly string[];
}

/** Compare two band lists, reporting the first place they differ. */
function bandDrift(
  name: string,
  recorded: readonly RubricBand[],
  live: readonly RubricBand[],
): readonly string[] {
  const problems: string[] = [];
  if (recorded.length !== live.length) {
    problems.push(
      `rubric snapshot ${name} has ${String(recorded.length)} bands, the contract has ${String(live.length)}`,
    );
    return problems;
  }
  for (const [index, band] of live.entries()) {
    const snapshot = recorded[index];
    if (snapshot === undefined || snapshot.score !== band.score) {
      problems.push(
        `rubric snapshot ${name}[${String(index)}] names score ${String(snapshot?.score)}, the contract names ${String(band.score)}`,
      );
    } else if (snapshot.criterion !== band.criterion) {
      problems.push(
        `rubric snapshot ${name} at score ${String(band.score)} reads "${snapshot.criterion}", the contract reads "${band.criterion}"`,
      );
    }
  }
  return problems;
}

/** Check one snapshot document against the contract and the rubric document. */
export function checkSnapshot(
  snapshot: RubricSnapshot,
  rubricDocument: string,
): RubricCheck {
  const problems = [
    ...bandDrift('risk', snapshot.risk, RISK_BANDS),
    ...bandDrift('authorization', snapshot.authorization, AUTHORIZATION_BANDS),
  ];
  const findings: string[] = [];
  const actual = sha256Text(rubricDocument);
  if (actual !== snapshot.source.sha256) {
    findings.push(
      `rubric document ${snapshot.source.path} changed since the snapshot was recorded (snapshot ${snapshot.source.sha256}, now ${actual}); confirm the bands still mean what rubricVersion ${snapshot.rubricVersion} says`,
    );
  }
  return { snapshot, problems, findings };
}
