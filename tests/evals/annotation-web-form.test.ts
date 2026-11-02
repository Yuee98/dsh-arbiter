import { describe, expect, test } from 'vitest';
import {
  changedMaterial,
  formAnswer,
  humanTarget,
} from '../../evals/src/annotation/web-form.js';
import { webMutation } from '../../evals/src/annotation/web-validation.js';
import { independentAnswer } from '../../evals/src/annotation/workflow-validation.js';
import { materialLines } from '../../evals/src/annotation/web-material.js';
import { EMPTY_FORM } from '../../evals/src/annotation/web-types.js';
describe('annotation web form contracts', () => {
  test('retains full pairs and independent behaviour, never their Cartesian product or a score matrix verdict', () => {
    const answer = independentAnswer(
      formAnswer({ ...EMPTY_FORM, pairs: '3,10\n4,9', behaviour: 'deny' }),
    );
    expect(
      humanTarget(answer, 'tester', 'confirmed', '2026-11-02'),
    ).toMatchObject({
      allowedPairs: [
        [3, 10],
        [4, 9],
      ],
      allowed: { risk: [3, 4], authorization: [10, 9] },
      behaviourReference: 'deny',
    });
    expect(() =>
      independentAnswer(formAnswer({ ...EMPTY_FORM, pairs: '0,11' })),
    ).toThrow();
  });
  test('explicit material-insufficient state retains null scores and behaviour', () => {
    expect(
      humanTarget(
        independentAnswer(formAnswer(EMPTY_FORM)),
        'tester',
        'undecidable',
        '2026-11-02',
      ),
    ).toMatchObject({
      status: 'pending',
      allowed: { risk: null, authorization: null },
      behaviourReference: null,
    });
  });
  test('raw drafts can be incomplete, but HTTP mutations cannot contain paths, extra decisions or invalid identity', () => {
    expect(
      webMutation({
        token: 'a'.repeat(36),
        revision: 0,
        form: { ...EMPTY_FORM, pairs: 'unfinished' },
        sampled: false,
      }).form.pairs,
    ).toBe('unfinished');
    expect(() =>
      webMutation({
        token: '../../holdout',
        revision: 0,
        form: EMPTY_FORM,
        sampled: false,
      }),
    ).toThrow();
    expect(() =>
      webMutation({
        token: 'a'.repeat(36),
        revision: 0,
        form: EMPTY_FORM,
        sampled: false,
        decisions: [],
      }),
    ).toThrow();
  });
  test('change highlights contain only current lines, never removed predecessor content', () => {
    const current = { material: 'new current quote' },
      previous = { material: 'old predecessor private text' };
    const lines = materialLines(current);
    const highlighted = changedMaterial(current, previous)
      .map((index) => lines[index])
      .join('\n');
    expect(highlighted).toContain('new current quote');
    expect(highlighted).not.toContain('old predecessor private text');
  });
});
