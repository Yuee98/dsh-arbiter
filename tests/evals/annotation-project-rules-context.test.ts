/** Synthetic contexts exercise both external and persisted validation contracts. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, test } from 'vitest';

const isolatedHome = await mkdtemp(join(tmpdir(), 'arbiter-rules-schema-'));
process.env['DSH_HOME'] = isolatedHome;
const { annotationContext, DEFAULT_ANNOTATION_CONTEXT } =
  await import('../../evals/src/annotation/workflow-view.js');
const { compileCheckers } = await import('../../evals/src/data/schemas.js');
const { opinion } = await import('./helpers/workflow-annotation.js');
const { collectionOf } = await import('./fixtures/workflow.js');
const checkers = await compileCheckers();
const original = opinion(0);
afterAll(async () => {
  await rm(isolatedHome, { recursive: true, force: true });
});
function persisted(context: unknown): boolean {
  return checkers.groupedOpinions(
    collectionOf({
      ...original,
      annotation: { ...original.annotation, context },
    }),
  ).ok;
}

describe('optional project rule state is compatible and strict', () => {
  test.each([
    {},
    { projectRules: '' },
    { projectRules: 'Synthetic project rule.' },
    { projectRulesEnabled: true },
    { projectRulesEnabled: true, projectRules: '' },
    { projectRulesEnabled: true, projectRules: 'Synthetic project rule.' },
    { projectRulesEnabled: false },
  ])('preserves legal context without injecting defaults: %j', (patch) => {
    const context = { ...DEFAULT_ANNOTATION_CONTEXT, ...patch };
    expect(annotationContext(context)).toEqual(context);
    expect(persisted(context)).toBe(true);
  });

  test.each([
    { projectRulesEnabled: null },
    { projectRulesEnabled: 'false' },
    { projectRulesEnabled: 0 },
    { projectRulesEnabled: {} },
    { projectRulesEnabled: false, projectRules: '' },
    { projectRulesEnabled: false, projectRules: 'Synthetic project rule.' },
    { projectRulesEnabled: false, projectRules: false },
    { projectRulesEnabled: false, unrelated: true },
  ])('rejects the same illegal state at both boundaries: %j', (patch) => {
    const context = { ...DEFAULT_ANNOTATION_CONTEXT, ...patch };
    expect(() => annotationContext(context)).toThrow();
    expect(persisted(context)).toBe(false);
  });

  test('retains required legacy fields and credential/budget validation with the new flag', () => {
    const { projectRules: _, ...missing } = DEFAULT_ANNOTATION_CONTEXT;
    expect(() =>
      annotationContext({ ...missing, projectRulesEnabled: false }),
    ).toThrow();
    expect(persisted({ ...missing, projectRulesEnabled: false })).toBe(false);
    expect(() =>
      annotationContext({
        ...DEFAULT_ANNOTATION_CONTEXT,
        projectRulesEnabled: false,
        targetInputTokens: 10001,
        maxInputTokens: 10000,
      }),
    ).toThrow(/must not exceed/u);
    expect(() =>
      annotationContext({
        ...DEFAULT_ANNOTATION_CONTEXT,
        projectRulesEnabled: false,
        customRules: 'password=synthetic-rule-secret',
      }),
    ).toThrow(/without credential/u);
  });
});
