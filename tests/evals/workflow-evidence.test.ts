import { expect, test } from 'vitest';
import { validEvidence } from '../../evals/src/annotation/workflow-evidence.js';

const marker = (digit: string, kind = 'password') =>
  `[redacted:v1:${kind}:${digit.repeat(64)}]`;
test.each([
  { source: ['a', 'a'], target: ['b', 'b'], valid: true },
  { source: ['a', 'a'], target: ['b', 'c'], valid: false },
  { source: ['a', 'b'], target: ['c', 'd'], valid: true },
  { source: ['a', 'b'], target: ['c', 'c'], valid: false },
])(
  'portable evidence keeps equality $source -> $target ($valid)',
  ({ source, target, valid }) => {
    const quote = source.map((value) => marker(value)).join(' and ');
    const request = {
      user: target.map((value) => marker(value)).join(' and '),
    };
    expect(validEvidence([quote], request)).toBe(false);
    expect(validEvidence([quote], request, true)).toBe(valid);
  },
);
test('portable evidence keeps marker kinds', () => {
  expect(
    validEvidence([marker('a')], { user: marker('b', 'token') }, true),
  ).toBe(false);
});
