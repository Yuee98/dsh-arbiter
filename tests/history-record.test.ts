import { describe, expect, test } from 'vitest';

import {
  asCallResult,
  comparePriorVerdicts,
  decodeDecisionRecord,
  decisionPayload,
  isPriorVerdictCandidate,
  mergeObservations,
  priorItemOf,
  resolveChain,
  selectWindow,
} from '../src/host/history-record.js';
import type { PriorVerdictItem } from '../src/types.js';

/**
 * The prior-verdict selector is the one definition memory, the session log and
 * SQLite all use, so these tests pin the properties that make them agree:
 * one candidate predicate, one identity, one ordering, and a chain merge that
 * never invents a stage or resolves a conflict toward allow or deny.
 */

function item(
  callId: string,
  ts: number,
  overrides: Partial<PriorVerdictItem> = {},
): PriorVerdictItem {
  return {
    ts,
    callId,
    configRevision: 'rev-1',
    tool: 'bash',
    fingerprint: `bash:${callId}`,
    trace: ['rule', 'review'],
    result: 'review-deny',
    ...overrides,
  };
}

describe('prior-verdict candidate selection', () => {
  test.each([
    ['allow', false],
    ['review-allow', false],
    ['human-allow', false],
    ['deny', true],
    ['review-deny', true],
    ['review-escalate', true],
    ['force-ask', true],
    ['force-review', true],
    ['human-deny', true],
    ['human-abort', true],
    ['fallback-deny', true],
  ])('treats %s as a prior verdict: %s', (result, expected) => {
    // A call that was allowed carries no precedent; its execution record is
    // already in the host tool-call history. Everything else is a real prior
    // outcome, including an escalation that never reached a verdict.
    expect(isPriorVerdictCandidate(result)).toBe(expected);
  });

  test('an unknown result is not a known call result', () => {
    expect(asCallResult('executed')).toBeNull();
    expect(asCallResult('deny')).toBe('deny');
  });
});

describe('stable ordering and the window', () => {
  test('orders by time and breaks ties by identity, not input order', () => {
    const listed = [item('c', 5), item('a', 5), item('b', 1)];
    const expected = ['b', 'a', 'c'];
    expect(
      listed.sort(comparePriorVerdicts).map((entry) => entry.callId),
    ).toEqual(expected);
    expect(
      [...listed]
        .reverse()
        .sort(comparePriorVerdicts)
        .map((e) => e.callId),
    ).toEqual(expected);
    // The window is the tail of that order, so it cannot depend on input order.
    for (const input of [
      listed,
      [...listed].reverse(),
      [listed[1], listed[2], listed[0]].filter(
        (entry): entry is PriorVerdictItem => entry !== undefined,
      ),
    ]) {
      expect(selectWindow(input, 2).selected.map((e) => e.callId)).toEqual([
        'a',
        'c',
      ]);
    }
  });

  test('one call occupies one slot however many sources observed it', () => {
    const selected = selectWindow(
      [
        item('shared', 10, { trace: ['rule'] }),
        item('shared', 10, { trace: ['rule', 'review'] }),
        item('other', 11),
      ],
      10,
    );
    expect(selected.selected.map((entry) => entry.callId)).toEqual([
      'shared',
      'other',
    ]);
    // The longer observed chain wins; the merge never rebuilds a stage.
    expect(selected.selected[0]?.trace).toEqual(['rule', 'review']);
    expect(selected.truncated).toBe(false);
  });

  test('reports truncation only when the window dropped a candidate', () => {
    const five = ['a', 'b', 'c', 'd', 'e'].map((id, index) =>
      item(id, index + 1),
    );
    expect(selectWindow(five, 3)).toMatchObject({ truncated: true });
    expect(selectWindow(five, 3).selected.map((entry) => entry.callId)).toEqual(
      ['c', 'd', 'e'],
    );
    // Exactly filling the window is not a truncation.
    expect(selectWindow(five, 5)).toMatchObject({ truncated: false });
    // Neither is a configured window larger than the population.
    expect(selectWindow(five, 40)).toMatchObject({ truncated: false });
  });

  test('a configured window below one still selects one', () => {
    expect(selectWindow([item('a', 1), item('b', 2)], 0).selected).toHaveLength(
      1,
    );
  });
});

describe('phase-chain completion', () => {
  test('keeps the longer chain when the shorter one is its prefix', () => {
    expect(resolveChain(['rule'], ['rule', 'review', 'human'])).toEqual({
      trace: ['rule', 'review', 'human'],
      conflicts: [],
    });
    // Argument order does not decide which chain is kept.
    expect(resolveChain(['rule', 'review', 'human'], ['rule']).trace).toEqual([
      'rule',
      'review',
      'human',
    ]);
  });

  test('treats a missing observation as no observation, not as a gap', () => {
    expect(resolveChain([], ['rule', 'review'])).toEqual({
      trace: ['rule', 'review'],
      conflicts: [],
    });
    expect(resolveChain(['rule'], [])).toEqual({
      trace: ['rule'],
      conflicts: [],
    });
  });

  test('reports a same-length disagreement instead of picking one', () => {
    const resolved = resolveChain(['rule', 'review-deny'], ['rule', 'review']);
    expect(resolved.trace).toEqual(['rule', 'review-deny']);
    expect(resolved.conflicts).toHaveLength(1);
    expect(resolved.conflicts[0]?.index).toBe(1);
    expect(resolved.conflicts[0]?.observed).toEqual(['review-deny', 'review']);
  });

  test('reports a prefix disagreement rather than trimming to agree', () => {
    const resolved = resolveChain(['deny'], ['review', 'human-deny']);
    expect(resolved.trace).toEqual(['review', 'human-deny']);
    expect(resolved.conflicts.length).toBeGreaterThan(0);
  });

  test('a merge never changes the conclusion the entry owns', () => {
    const kept = item('c1', 5, { result: 'review-deny', trace: ['rule'] });
    const other = item('c1', 5, {
      result: 'allow',
      trace: ['rule', 'review'],
    });
    const merged = mergeObservations(kept, other);
    // The entry keeps its own result; the disagreement is recorded, not applied.
    expect(merged.result).toBe('review-deny');
    expect(merged.trace).toEqual(['rule', 'review']);
    expect(merged.conflicts?.map((conflict) => conflict.field)).toContain(
      'result',
    );
    // Both readings are preserved so nothing is presented as one conclusion.
    const resultConflict = merged.conflicts?.find(
      (conflict) => conflict.field === 'result',
    );
    expect(resultConflict?.observed).toEqual(['review-deny', 'allow']);
  });

  test('a conflicting entry survives the candidate filter', () => {
    // Without this, a call one source recorded as an allow would vanish from the
    // window entirely and its conflict would be invisible.
    const selected = selectWindow(
      [item('c1', 1, { result: 'allow' }), item('c1', 1, { result: 'deny' })],
      10,
    );
    expect(selected.selected).toHaveLength(1);
    expect(selected.selected[0]?.conflicts?.length).toBeGreaterThan(0);
  });

  test('fills an optional field from the observation that has it', () => {
    const merged = mergeObservations(
      item('c1', 1, { trace: ['rule'] }),
      item('c1', 1, {
        trace: ['rule', 'review'],
        reason: 'stored reason',
        ruleId: 'r-1',
        decisionRules: ['R5'],
        effect: { writes: ['build'] },
      }),
    );
    expect(merged).toMatchObject({
      reason: 'stored reason',
      ruleId: 'r-1',
      decisionRules: ['R5'],
      effect: { writes: ['build'] },
    });
  });

  test('keeps the first observation time, which is when the call was decided', () => {
    const merged = mergeObservations(
      item('c1', 1),
      item('c1', 99, { trace: ['rule', 'review', 'human'] }),
    );
    expect(merged.ts).toBe(1);
  });
});

describe('decision record codec', () => {
  test('round-trips the fields a cold reader needs', () => {
    const original = item('c1', 1_700_000_000_000, {
      tool: 'write',
      fingerprint: 'write:abc',
      trace: ['rule', 'review', 'human'],
      result: 'human-deny',
      reason: 'the user rejected this call',
      ruleId: 'r-7',
      decisionRules: ['R3'],
      configRevision: 'rev-9',
    });
    const decoded = decodeDecisionRecord(decisionPayload(original), {
      time: undefined,
      seq: 4,
    });
    expect(decoded).not.toBeNull();
    if (decoded === null) throw new Error('the payload did not decode');
    expect(priorItemOf(decoded)).toMatchObject(original);
  });

  test('still reads the version 1 payload an earlier build wrote', () => {
    // Shipped builds wrote `version: 1` with a `string[]` trace; those records
    // must stay interpretable, or an existing session loses its history.
    const legacy = {
      version: 1,
      callId: 'legacy-call',
      tool: 'bash',
      fingerprint: 'bash:legacy',
      trace: ['rule', 'review', 'human'],
      result: 'human-deny',
      reason: 'rejected',
      ruleId: null,
      decisionRules: ['R3'],
      configRevision: 'rev-old',
      effect: null,
      ts: 1_690_000_000_000,
    };
    const record = decodeDecisionRecord(legacy, { time: 2, seq: 3 });
    expect(record).toEqual({
      callId: 'legacy-call',
      ts: 1_690_000_000_000,
      configRevision: 'rev-old',
      tool: 'bash',
      fingerprint: 'bash:legacy',
      trace: ['rule', 'review', 'human'],
      result: 'human-deny',
      reason: 'rejected',
      decisionRules: ['R3'],
    });
  });

  test('falls back to the envelope time for a payload without its own', () => {
    const record = decodeDecisionRecord(
      { callId: 'c1', tool: 'bash', result: 'deny', trace: ['rule'] },
      { time: 1_234, seq: 9 },
    );
    expect(record?.ts).toBe(1_234);
    const withoutTime = decodeDecisionRecord(
      { callId: 'c1', tool: 'bash', result: 'deny' },
      { time: undefined, seq: 9 },
    );
    // The host wrote the envelope, so its sequence is a real observation time.
    expect(withoutTime?.ts).toBe(9);
  });

  test.each([
    ['no result', { callId: 'c', tool: 'bash' }],
    ['unknown result', { callId: 'c', tool: 'bash', result: 'executed' }],
    ['no tool', { callId: 'c', result: 'deny' }],
    ['no callId', { tool: 'bash', result: 'deny' }],
    ['empty callId', { callId: '', tool: 'bash', result: 'deny' }],
    ['not an object', 'plugin:arbiter/decision'],
    ['null', null],
    ['an array', [{ callId: 'c' }]],
  ])('refuses a payload with %s rather than guessing it', (_label, data) => {
    // Manufacturing identity or a result would fabricate a decision.
    expect(decodeDecisionRecord(data, { time: 1, seq: 1 })).toBeNull();
  });

  test('drops non-string trace entries instead of keeping placeholders', () => {
    const record = decodeDecisionRecord(
      {
        callId: 'c',
        tool: 'bash',
        result: 'deny',
        trace: ['rule', 7, null, 'review'],
      },
      { time: 1, seq: 1 },
    );
    expect(record?.trace).toEqual(['rule', 'review']);
  });

  test('an empty reason is absent, not an empty string', () => {
    // An empty reason would travel to the reviewer as a stated reason.
    const record = decodeDecisionRecord(
      { callId: 'c', tool: 'bash', result: 'deny', reason: '' },
      { time: 1, seq: 1 },
    );
    expect(record?.reason).toBeUndefined();
    if (record === null) throw new Error('the payload did not decode');
    expect(priorItemOf(record)).not.toHaveProperty('reason');
  });

  test('conflict evidence stays bounded when one call is observed many times', () => {
    // The same call, observed repeatedly with two different rejected results. The
    // merged entry must keep one entry per field with at most two readings, so the
    // evidence cannot grow with the observation count.
    const base: PriorVerdictItem = {
      ts: 1,
      callId: 'c1',
      configRevision: 'rev-1',
      tool: 'bash',
      fingerprint: 'bash:c1',
      trace: ['allow'],
      result: 'allow',
    };
    let merged = base;
    for (let index = 0; index < 50; index += 1) {
      merged = mergeObservations(merged, {
        ...base,
        trace: index % 2 === 0 ? ['allow'] : ['review-allow'],
        result: index % 2 === 0 ? 'allow' : 'review-allow',
      });
    }
    const conflicts = merged.conflicts ?? [];
    // One entry per field.
    const fields = conflicts.map((conflict) => conflict.field);
    expect(new Set(fields).size).toBe(fields.length);
    // At most two readings per field.
    for (const conflict of conflicts) {
      expect(conflict.observed.length).toBeLessThanOrEqual(2);
    }
    // And the disagreement itself is preserved, not resolved away.
    expect(fields).toContain('result');
    // Alternating between two values never exceeds the representable bound.
    expect(merged.conflictsTruncated).toBeUndefined();
  });

  test('a third distinct reading bounds the evidence and says so on the entry', () => {
    // Three different results for one call exceed what a single entry can show, so
    // the entry keeps two readings and carries the truncation fact with it.
    const base: PriorVerdictItem = {
      ts: 1,
      callId: 'c1',
      configRevision: 'rev-1',
      tool: 'bash',
      fingerprint: 'bash:c1',
      trace: ['deny'],
      result: 'deny',
    };
    let merged = base;
    for (const result of ['deny', 'review-deny', 'human-deny'] as const) {
      merged = mergeObservations(merged, {
        ...base,
        trace: [result],
        result,
      });
    }
    const fields = (merged.conflicts ?? []).map((conflict) => conflict.field);
    expect(fields).toContain('result');
    for (const conflict of merged.conflicts ?? []) {
      expect(conflict.observed.length).toBeLessThanOrEqual(2);
    }
    // The fact belongs to the entry, so a dropped call cannot leave it behind.
    expect(merged.conflictsTruncated).toBe(true);
  });

  test('an aggregate that already exceeded the bound keeps its fact when merged', () => {
    // The audit deny is one observation; the session side already folded three
    // allow-family readings into one entry that exceeded the bound. Merging them
    // must keep the fact: dropping it would hide a known gap behind a cleaner
    // looking entry.
    const aggregated: PriorVerdictItem = {
      ts: 1,
      callId: 'c1',
      configRevision: 'rev-1',
      tool: 'bash',
      fingerprint: 'bash:c1',
      trace: ['allow'],
      result: 'allow',
      conflictsTruncated: true,
    };
    const auditDeny: PriorVerdictItem = {
      ts: 1,
      callId: 'c1',
      configRevision: 'rev-1',
      tool: 'bash',
      fingerprint: 'bash:c1',
      trace: ['deny'],
      result: 'deny',
    };
    const merged = mergeObservations(auditDeny, aggregated);
    expect(merged.conflictsTruncated).toBe(true);
    // The conclusion still comes from the observation that owned the entry.
    expect(merged.result).toBe('deny');
    // And the other side's accumulated evidence is not discarded: the result
    // contradiction survives the bounded merge.
    expect(
      (merged.conflicts ?? []).map((conflict) => conflict.field),
    ).toContain('result');
  });

  test('a truncation flag survives later merges of the same call', () => {
    const base: PriorVerdictItem = {
      ts: 1,
      callId: 'c1',
      configRevision: 'rev-1',
      tool: 'bash',
      fingerprint: 'bash:c1',
      trace: ['deny'],
      result: 'deny',
      conflictsTruncated: true,
    };
    // A later observation that agrees adds nothing, and must not clear the fact
    // that an earlier one exceeded the bound.
    const merged = mergeObservations(base, { ...base });
    expect(merged.conflictsTruncated).toBe(true);
  });
});
