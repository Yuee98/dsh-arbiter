/**
 * Verdict rules for `scripts/check-regressions.ts`.
 *
 * The historical R1–R9 reproducer must stay byte-identical as prototype
 * evidence, but the first release removes the prototype's accept endpoint.
 * Case R8 therefore no longer passes. Excusing it by name would accept any
 * failure of R8, including a real defect, so instead its recorded observations
 * are held to the exact reason the first release created:
 *
 *   - the acceptance attempt did not reach a handler (`acceptError` set, or a
 *     plain host not-found answer) because the route no longer exists;
 *   - the seeded candidate stayed `pending`;
 *   - no rule was added to the live configuration.
 *
 * If a prototype accept route is restored and succeeds, R8 passes and these
 * observations change to `accepted` / a handler JSON answer, so the verdict
 * fails instead of silently accepting the regression.
 */

import type { EngineProbeReport } from './retired-engine.ts';
import { expectedEngineLabels } from './retired-engine.ts';

export interface CaseObservation {
  readonly id: string;
  readonly passes: boolean;
  readonly actual: unknown;
}

export interface RunVerdict {
  readonly ok: boolean;
  readonly problems: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Parse a runner's `results.json`; null when the report is unreadable. */
export function parseCases(parsed: unknown): readonly CaseObservation[] | null {
  if (!isRecord(parsed)) return null;
  const results = parsed['results'];
  if (!Array.isArray(results)) return null;
  const cases: CaseObservation[] = [];
  for (const entry of results) {
    if (!isRecord(entry)) return null;
    const id = entry['id'];
    const passes = entry['passes'];
    if (typeof id !== 'string' || typeof passes !== 'boolean') return null;
    cases.push({ id, passes, actual: entry['actual'] });
  }
  return cases;
}

/**
 * Historical R8 must have failed for the scope reason, not for an unrelated
 * defect. Every observation is checked positively.
 */
function historicalAcceptanceProblems(
  observation: CaseObservation | undefined,
): readonly string[] {
  if (observation === undefined) {
    return ['R8 is missing from the historical results'];
  }
  const problems: string[] = [];
  if (observation.passes) {
    problems.push(
      'R8 passed, so the prototype accept route appears reachable again',
    );
  }
  if (!isRecord(observation.actual)) {
    return [...problems, 'R8 recorded no observation details'];
  }
  const actual = observation.actual;
  if (actual['candidateStatus'] !== 'pending') {
    problems.push(
      `R8 candidate status is ${JSON.stringify(actual['candidateStatus'])}, expected "pending"`,
    );
  }
  if (actual['ruleAdded'] === true) {
    problems.push('R8 reported a rule added to the live configuration');
  }
  const response = actual['acceptResponse'];
  if (response !== null && response !== undefined) {
    problems.push(
      `R8 received a handler response ${JSON.stringify(response)} instead of an unroutable accept`,
    );
  } else if (
    typeof actual['acceptError'] !== 'string' ||
    actual['acceptError'].length === 0
  ) {
    problems.push('R8 recorded no reason for the failed accept attempt');
  }
  return problems;
}

/** Historical R1–R7 and R9 keep their original passing requirement. */
export function historicalVerdict(
  cases: readonly CaseObservation[],
): RunVerdict {
  const problems = cases
    .filter((entry) => entry.id !== 'R8' && !entry.passes)
    .map((entry) => `${entry.id} failed`);
  return {
    ok:
      problems.length === 0 &&
      historicalAcceptanceProblems(cases.find((entry) => entry.id === 'R8'))
        .length === 0,
    problems: [
      ...problems,
      ...historicalAcceptanceProblems(cases.find((entry) => entry.id === 'R8')),
    ],
  };
}

/** First-release scope cases must all pass with no exception list. */
export function scopeVerdict(cases: readonly CaseObservation[]): RunVerdict {
  const problems = cases
    .filter((entry) => !entry.passes)
    .map((entry) => `${entry.id} failed`);
  return { ok: problems.length === 0, problems };
}

/**
 * Whether the historical R1–R9 run may be retired, and why.
 *
 * The frozen script imports a retired engine at module scope. When — and only
 * when — the probe proves every one of those symbols is gone from the build, the
 * script cannot run and the historical evidence stays as it was written. Any other
 * outcome keeps the run mandatory:
 *
 *   - a symbol is back → the build still has the old engine, so the script must run
 *     and pass; retiring it would hide whatever it now finds;
 *   - the probe could not read a module → the build is not in the state this rule
 *     describes, so the run is required rather than excused.
 *
 * `results.json` being missing is never by itself a reason to retire the run: a
 * script that crashed for an unrelated reason also produces no file. The probe is
 * what distinguishes the two.
 */
export function retiredVerdict(
  report: EngineProbeReport,
): RunVerdict & { readonly retired: boolean } {
  const expected = expectedEngineLabels();
  const unreadable = report.unreadable;
  const present = report.present.filter((label) => expected.includes(label));
  if (unreadable.length > 0) {
    return {
      retired: false,
      ok: false,
      problems: [
        `the retired-engine probe could not read: ${unreadable.join(', ')}`,
      ],
    };
  }
  // A report that does not cover the whole list cannot prove retirement: a probe
  // that silently skipped a symbol would retire a script that still has a symbol
  // to import.
  const covered = [...report.absent, ...present];
  const missingCoverage = expected.filter((label) => !covered.includes(label));
  if (missingCoverage.length > 0) {
    return {
      retired: false,
      ok: false,
      problems: [
        `the retired-engine probe reported nothing for: ${missingCoverage.join(', ')}`,
      ],
    };
  }
  if (present.length > 0) {
    return {
      retired: false,
      ok: false,
      problems: [
        `the retired engine is exported again (${present.join(', ')}); the historical R1–R9 run must pass on its own`,
      ],
    };
  }
  return { retired: true, ok: true, problems: [] };
}
