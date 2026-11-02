import { describe, expect, test } from 'vitest';
import { parseContext } from '../../src/config/context.js';
import {
  annotationContext,
  DEFAULT_ANNOTATION_CONTEXT,
} from '../../evals/src/annotation/workflow-view.js';
import { compileCheckers } from '../../evals/src/data/schemas.js';
import { collectionOf } from './fixtures/workflow.js';
import { opinion } from './helpers/workflow-annotation.js';

const unsafe = Number.MAX_SAFE_INTEGER + 1;
const fields = ['targetInputTokens', 'maxInputTokens'] as const;

describe('annotation budgets match production numeric boundaries', () => {
  test.each(
    fields.flatMap((field) =>
      [
        0,
        -1,
        1.5,
        unsafe,
        Number.MAX_VALUE,
        NaN,
        Infinity,
        -Infinity,
        '10000',
      ].map((value) => ({ field, value })),
    ),
  )('rejects $field=$value at the production boundary', ({ field, value }) => {
    const context = {
      ...DEFAULT_ANNOTATION_CONTEXT,
      targetInputTokens: 1,
      maxInputTokens: Number.MAX_SAFE_INTEGER,
      [field]: value,
    };
    const errors: Parameters<typeof parseContext>[1] = [];
    parseContext(
      {
        context: {
          targetInputTokens: context.targetInputTokens,
          maxInputTokens: context.maxInputTokens,
        },
      },
      errors,
    );
    expect(errors.some((error) => error.path === `context.${field}`)).toBe(
      true,
    );
    expect(() => annotationContext(context)).toThrow();
  });

  test.each([1, Number.MAX_SAFE_INTEGER])(
    'preserves legal boundary %i',
    (value) => {
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        targetInputTokens: value,
        maxInputTokens: value,
      };
      const errors: Parameters<typeof parseContext>[1] = [];
      parseContext(
        {
          context: {
            targetInputTokens: context.targetInputTokens,
            maxInputTokens: context.maxInputTokens,
          },
        },
        errors,
      );
      expect(errors).toEqual([]);
      expect(annotationContext(context)).toEqual(context);
    },
  );

  test('still rejects target above the hard budget', () => {
    expect(() =>
      annotationContext({
        ...DEFAULT_ANNOTATION_CONTEXT,
        targetInputTokens: 2,
        maxInputTokens: 1,
      }),
    ).toThrow(/must not exceed/u);
  });

  test.each(fields)(
    'persisted opinions enforce safe %s without a new cap',
    async (field) => {
      const checkers = await compileCheckers();
      const original = opinion(0);
      if (original.annotation === undefined)
        throw new Error('fixture annotation');
      const context = {
        ...DEFAULT_ANNOTATION_CONTEXT,
        targetInputTokens: Number.MAX_SAFE_INTEGER,
        maxInputTokens: Number.MAX_SAFE_INTEGER,
      };
      const record = {
        ...original,
        annotation: { ...original.annotation, context },
      };
      expect(checkers.groupedOpinions(collectionOf(record)).ok).toBe(true);
      expect(
        checkers.groupedOpinions(
          collectionOf({
            ...record,
            annotation: {
              ...record.annotation,
              context: { ...context, [field]: unsafe },
            },
          }),
        ).ok,
      ).toBe(false);
    },
  );
});
