import { describe, expect, it } from 'vitest';

import {
  historicalVerdict,
  parseCases,
  retiredVerdict,
  scopeVerdict,
} from '../../scripts/regression-verdict.ts';
import type { CaseObservation } from '../../scripts/regression-verdict.ts';

/**
 * The historical R8 case lost its accept endpoint in the first release. These
 * tests pin that the gate fails for that specific observed reason and for
 * unrelated failures, rather than excusing R8 by name.
 */

const ok = (id: string, actual: unknown = {}): CaseObservation => ({
  id,
  passes: true,
  actual,
});

const failed = (id: string, actual: unknown): CaseObservation => ({
  id,
  passes: false,
  actual,
});

const HISTORICAL_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6', 'R7'];

/** R8's real observation once the accept route is gone. */
const removedRoute = {
  acceptError:
    "TypeError: Cannot read properties of undefined (reading 'fetch')",
  acceptResponse: null,
  candidateStatus: 'pending',
  ruleAdded: false,
};

function historical(r8: CaseObservation): readonly CaseObservation[] {
  return [...HISTORICAL_IDS.map((id) => ok(id)), r8, ok('R9')];
}

describe('historical regression verdict', () => {
  it('accepts R8 failing because the accept route is gone and nothing changed', () => {
    const verdict = historicalVerdict(historical(failed('R8', removedRoute)));
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it('rejects R8 when the prototype accept route is reachable again', () => {
    const accepted = failed('R8', {
      acceptError: null,
      acceptResponse: { ok: true, status: 'accepted' },
      candidateStatus: 'pending',
      ruleAdded: false,
    });
    const verdict = historicalVerdict(historical(accepted));
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('handler response');
  });

  it('rejects R8 passing, which would mean acceptance works again', () => {
    const verdict = historicalVerdict(
      historical(ok('R8', { candidateStatus: 'accepted', ruleAdded: true })),
    );
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain(
      'prototype accept route appears reachable',
    );
  });

  it('rejects R8 when the candidate was accepted or a rule was added', () => {
    const acceptedCandidate = historicalVerdict(
      historical(
        failed('R8', { ...removedRoute, candidateStatus: 'accepted' }),
      ),
    );
    expect(acceptedCandidate.ok).toBe(false);
    expect(acceptedCandidate.problems.join(' ')).toContain(
      'expected "pending"',
    );

    const addedRule = historicalVerdict(
      historical(failed('R8', { ...removedRoute, ruleAdded: true })),
    );
    expect(addedRule.ok).toBe(false);
    expect(addedRule.problems.join(' ')).toContain('rule added');
  });

  it('rejects R8 when it failed for an unexplained or unobserved reason', () => {
    const unexplained = historicalVerdict(
      historical(
        failed('R8', {
          acceptError: null,
          acceptResponse: null,
          candidateStatus: 'pending',
          ruleAdded: false,
        }),
      ),
    );
    expect(unexplained.ok).toBe(false);
    expect(unexplained.problems.join(' ')).toContain('no reason');

    const unrecorded = historicalVerdict(historical(failed('R8', null)));
    expect(unrecorded.ok).toBe(false);
    expect(unrecorded.problems.join(' ')).toContain('no observation details');

    const missing = historicalVerdict([
      ...HISTORICAL_IDS.map((id) => ok(id)),
      ok('R9'),
    ]);
    expect(missing.ok).toBe(false);
    expect(missing.problems.join(' ')).toContain('missing');
  });

  it('still requires R1–R7 and R9 to pass', () => {
    const verdict = historicalVerdict([
      ...HISTORICAL_IDS.map((id) => ok(id)),
      failed('R5', { anything: true }),
      failed('R8', removedRoute),
      ok('R9'),
    ]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toContain('R5 failed');
  });
});

describe('first-release scope verdict', () => {
  it('accepts a fully passing scope run', () => {
    expect(scopeVerdict([ok('S1'), ok('S2'), ok('S3')])).toEqual({
      ok: true,
      problems: [],
    });
  });

  it('accepts no named exception for any case', () => {
    const verdict = scopeVerdict([ok('S1'), failed('S2', {}), ok('S3')]);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems).toEqual(['S2 failed']);
  });
});

describe('results parsing', () => {
  it('reads ids, pass flags and observations', () => {
    expect(
      parseCases({
        results: [{ id: 'R1', passes: true, actual: { a: 1 } }],
      }),
    ).toEqual([{ id: 'R1', passes: true, actual: { a: 1 } }]);
  });

  it('rejects malformed or missing reports instead of assuming success', () => {
    expect(parseCases(null)).toBeNull();
    expect(parseCases({})).toBeNull();
    expect(parseCases({ results: {} })).toBeNull();
    expect(parseCases({ results: [{ id: 1, passes: true }] })).toBeNull();
    expect(parseCases({ results: [{ id: 'R1', passes: 'yes' }] })).toBeNull();
    expect(parseCases({ results: [null] })).toBeNull();
  });
});

describe('retiring the historical run', () => {
  /** The report the probe produces once every retired symbol is gone. */
  const allAbsent = {
    absent: [
      'policy.decideReview',
      'reviewer.signalsFromChat',
      'reviewer.renderRequest',
      'reviewer.runDecisionReviewer',
      'reviewer.parseDecisionResponse',
    ],
    present: [],
    unreadable: [],
  };

  it('retires the run only when every imported symbol is gone', () => {
    const verdict = retiredVerdict(allAbsent);
    expect(verdict.retired).toBe(true);
    expect(verdict.ok).toBe(true);
  });

  it('keeps the run mandatory when any symbol is exported again', () => {
    // The positive assertion this exemption exists for: if someone restores the old
    // engine, the run must happen and must pass on its own merits.
    for (const symbol of allAbsent.absent) {
      const verdict = retiredVerdict({
        ...allAbsent,
        absent: allAbsent.absent.filter((entry) => entry !== symbol),
        present: [symbol],
      });
      expect(verdict.retired).toBe(false);
      expect(verdict.ok).toBe(false);
      expect(verdict.problems.join(' ')).toContain(symbol);
    }
  });

  it('keeps the run mandatory when only some symbols are gone', () => {
    // A partially retired engine means the script still has something to import, so
    // it can still run — and must.
    const verdict = retiredVerdict({
      absent: ['policy.decideReview'],
      present: [
        'reviewer.signalsFromChat',
        'reviewer.renderRequest',
        'reviewer.runDecisionReviewer',
        'reviewer.parseDecisionResponse',
      ],
      unreadable: [],
    });
    expect(verdict.retired).toBe(false);
    expect(verdict.ok).toBe(false);
  });

  it('keeps the run mandatory when the probe cannot read the build', () => {
    // "Cannot inspect" is not "the symbols are gone": retiring here would accept a
    // broken build as the documented end state.
    const verdict = retiredVerdict({
      absent: [],
      present: [],
      unreadable: ['policy (module not found)'],
    });
    expect(verdict.retired).toBe(false);
    expect(verdict.ok).toBe(false);
    expect(verdict.problems.join(' ')).toContain('could not read');
  });

  it('keeps the run mandatory when the probe covered only part of the list', () => {
    // A probe that silently skipped a symbol would retire a script that still has
    // that symbol to import, so the report has to cover the whole contract.
    const verdict = retiredVerdict({
      absent: ['policy.decideReview'],
      present: [],
      unreadable: [],
    });
    expect(verdict.retired).toBe(false);
    expect(verdict.problems.join(' ')).toContain('reported nothing for');
  });
});
