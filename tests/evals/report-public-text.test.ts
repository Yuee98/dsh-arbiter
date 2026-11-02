import { expect, test } from 'vitest';
import { publicReport } from '../../evals/src/report/public-text.js';

test('public text uses one vocabulary without treating score/count numbers as credentials', () => {
  const secret = 'synthetic_text_secret_131';
  const report = {
    run: { runId: 'fixture' },
    authorization: { compared: 9, rate: 1 },
    pairs: [[1, 9]],
    notes: [`Authorization: Bearer ${secret}`, 'Scores are 1 and 9.'],
    failure: { detail: `upstream error ${secret}` },
    path: `/tmp/${secret}/record`,
  };
  const before = JSON.stringify(report);
  const first = publicReport(report);
  expect(first.authorization).toEqual(report.authorization);
  expect(first.pairs).toEqual([[1, 9]]);
  expect(first.notes).toEqual(['[redacted]', 'Scores are 1 and 9.']);
  expect(first.failure.detail).toBe('[redacted]');
  expect(first.path).toBe('[redacted]');
  expect(JSON.stringify(first)).not.toContain(secret);
  expect(publicReport(report)).toEqual(first);
  expect(JSON.stringify(report)).toBe(before);
});
test('redacted dynamic keys cannot silently merge distinct categories', () => {
  const secret = 'synthetic_dynamic_secret_131';
  const report = {
    run: { runId: 'fixture' },
    notes: [`Authorization: Bearer ${secret}`],
    excludedByReason: { [secret]: 1, [`Authorization: Bearer ${secret}`]: 2 },
  };
  expect(() => publicReport(report)).toThrow('collide');
});
test('actual credential recognition resource exhaustion fails closed', () => {
  const report = {
    run: { runId: 'fixture' },
    notes: ['x'.repeat(16 * 1024 * 1024 + 1)],
  };
  expect(() => publicReport(report)).toThrow('recognition unavailable');
});

test('quoted credentials cannot rewrite closed source/status values or their denominators', () => {
  const report = {
    run: { runId: 'fixture' },
    source: 'human',
    status: 'reviewed',
    protocols: ['chat'],
    cellsBySource: { human: 2, unresolved: 1 },
    statuses: { reviewed: 2 },
    byGroup: [
      { axis: 'reference-source', key: 'human' },
      { axis: 'protocol', key: 'chat' },
    ],
    notes: [
      'Authorization: Bearer human',
      'Authorization: Bearer reviewed',
      'Authorization: Bearer chat',
    ],
  };
  const result = publicReport(report);
  expect(result.source).toBe('human');
  expect(result.status).toBe('reviewed');
  expect(result.protocols).toEqual(['chat']);
  expect(result.cellsBySource).toEqual({ human: 2, unresolved: 1 });
  expect(result.statuses).toEqual({ reviewed: 2 });
  expect(result.byGroup).toEqual(report.byGroup);
  expect(result.notes).toEqual(['[redacted]', '[redacted]', '[redacted]']);
});
test('redacted identities cannot silently merge two different report groups', () => {
  const report = {
    run: { runId: 'fixture' },
    notes: [
      'Authorization: Bearer synthetic_group_one',
      'Authorization: Bearer synthetic_group_two',
    ],
    examples: [
      { group: 'synthetic_group_one' },
      { group: 'synthetic_group_two' },
    ],
  };
  expect(() => publicReport(report)).toThrow('identifiers collide');
});

test('credential text cannot rename fixed schema keys or rewrite qualification categories', () => {
  const report = {
    run: { runId: 'fixture' },
    source: 'human',
    notes: [
      'notes',
      'runId',
      'source',
      'gold',
      'record',
      'reviewed',
      'ordinary',
      'original',
      'not-computed',
    ].map((value) => `Authorization: Bearer ${value}`),
    examples: [
      {
        labelStatus: 'gold',
        caseFactsSource: 'record',
        outcomeStatus: 'reviewed',
        challengeClass: 'ordinary',
        origin: 'original',
        costStatus: 'not-computed',
        rationale: 'gold',
      },
    ],
    diagnostics: { labels: { gold: 1, excludedByReason: { gold: 1 } } },
  };
  const result = publicReport(report);
  expect(Object.keys(result)).toEqual(Object.keys(report));
  expect(Object.keys(result.run)).toEqual(['runId']);
  expect(result.run.runId).toBe('fixture');
  expect(result.source).toBe('human');
  expect(result.examples[0]).toEqual({
    ...report.examples[0],
    rationale: '[redacted]',
  });
  expect(result.notes).toEqual(Array.from({ length: 9 }, () => '[redacted]'));
  expect(result.diagnostics.labels.gold).toBe(1);
  expect(result.diagnostics.labels.excludedByReason).toEqual({
    '[redacted]': 1,
  });
});

test('free family keys and dynamic reason keys remain sanitized when schema keys are preserved', () => {
  const report = {
    run: { runId: 'fixture' },
    notes: [
      'Authorization: Bearer synthetic_family_131',
      'Authorization: Bearer notes',
    ],
    byGroup: [
      { axis: 'family', key: 'synthetic_family_131', counts: { cells: 1 } },
    ],
    excludedByReason: { notes: 1 },
  };
  const result = publicReport(report);
  expect(result.byGroup).toEqual([
    { axis: 'family', key: '[redacted]', counts: { cells: 1 } },
  ]);
  expect(result.excludedByReason).toEqual({ '[redacted]': 1 });
  expect(result.notes).toEqual(['[redacted]', '[redacted]']);
});
