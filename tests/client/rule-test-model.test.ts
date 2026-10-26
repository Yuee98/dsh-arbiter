import { describe, expect, test } from 'vitest';

import {
  buildSample,
  conditionViews,
  coverageView,
  defaultTool,
  finalPath,
  issueTarget,
  ruleConclusion,
  testSignature,
} from '../../src/client/components/rules/rule-test-model.js';
import type { RuleTestResultView } from '../../src/client/view-types.js';
import type {
  RuleConditionResult,
  RuleResult,
  RuleVerdict,
} from '../../src/types.js';

function condition(
  overrides: Partial<RuleConditionResult> = {},
): RuleConditionResult {
  return {
    index: 0,
    target: 'argument',
    kind: 'exact',
    pattern: 'production',
    outcome: 'match',
    ...overrides,
  };
}

function rule(overrides: Partial<RuleResult> = {}): RuleResult {
  return {
    index: 0,
    id: 'deny-production',
    verdict: 'deny',
    outcome: 'match',
    conditions: [condition()],
    ...overrides,
  };
}

function result(
  overrides: Partial<RuleTestResultView> = {},
): RuleTestResultView {
  return {
    input: 'deploy',
    tool: 'deploy',
    path: 'deny',
    pathDetail: { kind: 'rule', verdict: 'deny', ruleId: 'deny-production' },
    cwd: '/w',
    rule: null,
    matches: [],
    rules: [rule()],
    parse: {
      status: 'ok',
      statements: 1,
      nodes: ['tool'],
      completeness: 'complete',
      opaque: false,
      unresolved: [],
    },
    argv: [],
    shadowed: [],
    ...overrides,
  };
}

describe('rule test sample building', () => {
  test('command text is passed through without normalizing it', () => {
    const built = buildSample({
      tool: 'bash',
      identity: 'main',
      mode: 'command',
      text: '  echo "a b"  ',
    });
    expect(built).toEqual({
      ok: true,
      sample: {
        tool: 'bash',
        args: { command: '  echo "a b"  ' },
        input: '  echo "a b"  ',
      },
    });
  });

  test('argument JSON keeps its types and nesting', () => {
    const built = buildSample({
      tool: 'deploy',
      identity: 'subagent',
      mode: 'arguments',
      text: '{"retries":3,"dryRun":false,"target":null,"list":[1]}',
    });
    expect(built).toEqual({
      ok: true,
      sample: {
        tool: 'deploy',
        args: { retries: 3, dryRun: false, target: null, list: [1] },
        input: '{"retries":3,"dryRun":false,"target":null,"list":[1]}',
      },
    });
  });

  test('a malformed document is reported at the input, not tested', () => {
    const built = buildSample({
      tool: 'deploy',
      identity: 'main',
      mode: 'arguments',
      text: '{"a":}',
    });
    expect(built.ok).toBe(false);
    if (built.ok) throw new Error('expected a syntax problem');
    expect(built.problem.kind).toBe('json-syntax');
  });

  test('a non-object argument document is a shape problem', () => {
    for (const text of ['[]', 'null', '"text"', '3']) {
      const built = buildSample({
        tool: 'deploy',
        identity: 'main',
        mode: 'arguments',
        text,
      });
      expect(built).toEqual({ ok: false, problem: { kind: 'json-shape' } });
    }
  });

  test('an empty tool or command is an input problem', () => {
    expect(
      buildSample({ tool: ' ', identity: 'main', mode: 'command', text: 'x' }),
    ).toEqual({ ok: false, problem: { kind: 'tool-required' } });
    expect(
      buildSample({
        tool: 'bash',
        identity: 'main',
        mode: 'command',
        text: ' ',
      }),
    ).toEqual({ ok: false, problem: { kind: 'command-required' } });
  });
});

describe('rule test conclusions', () => {
  test('a rule scoped out is not reported as a plain mismatch', () => {
    const scopedOut = rule({
      outcome: 'no-match',
      conditions: [condition({ outcome: 'no-match', reason: 'scope' })],
    });
    expect(
      ruleConclusion(result({ rules: [scopedOut] }), {
        id: 'deny-production',
        conditions: [],
        verdict: 'deny',
      }),
    ).toEqual({ state: 'scope', result: scopedOut });
    expect(
      ruleConclusion(result({ rules: [scopedOut] }), {
        id: 'deny-production',
        conditions: [],
        verdict: 'deny',
        enabled: false,
      }),
    ).toEqual({ state: 'disabled', result: scopedOut });
  });

  test('an unknown outcome keeps its own state', () => {
    const unknown = rule({
      outcome: 'unknown',
      conditions: [condition({ outcome: 'unknown', reason: 'parse-error' })],
    });
    expect(
      ruleConclusion(result({ rules: [unknown] }), {
        id: 'deny-production',
        conditions: [],
        verdict: 'deny',
      }).state,
    ).toBe('unknown');
  });

  test('a rule missing from the answer is not presented as evaluated', () => {
    expect(
      ruleConclusion(result({ rules: [] }), {
        id: 'other',
        conditions: [],
        verdict: 'allow',
      }),
    ).toEqual({ state: 'not-tested', result: null });
    expect(ruleConclusion(result(), null)).toEqual({
      state: 'not-tested',
      result: null,
    });
  });

  test('the final path carries the review reason, not only the word', () => {
    for (const reason of [
      'no-match',
      'incomplete',
      'unresolved',
      'partial-allow',
    ] as const) {
      expect(
        finalPath(
          result({
            path: 'review(default)',
            pathDetail: { kind: 'review-default', reason },
          }),
        ),
      ).toEqual({ kind: 'review', reason });
    }
    expect(
      finalPath(
        result({
          path: 'force-ask',
          pathDetail: {
            kind: 'rule',
            verdict: 'force-ask',
            ruleId: 'ask-deploy',
            hint: 'deploys',
          },
        }),
      ),
    ).toEqual({
      kind: 'rule',
      verdict: 'force-ask',
      ruleId: 'ask-deploy',
      hint: 'deploys',
    });
  });

  test('coverage separates shadowed matches from undecided rules', () => {
    const shadowed = rule({ index: 1, id: 'allow-deploy', verdict: 'allow' });
    const unknown = rule({
      index: 0,
      id: 'deny-redirect',
      verdict: 'deny',
      outcome: 'unknown',
      conditions: [
        condition({ outcome: 'unknown', reason: 'unresolved-structure' }),
      ],
    });
    const view = coverageView(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'unresolved' },
        matches: [
          {
            index: 0,
            id: 'ask-deploy',
            verdict: 'force-ask',
            effective: true,
            target: 'tool',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'deploy',
          },
          {
            index: 1,
            id: 'allow-deploy',
            verdict: 'allow',
            effective: false,
            target: 'tool',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'deploy',
          },
        ],
        rules: [unknown, { ...shadowed, outcome: 'match' }],
      }),
    );
    expect(view.unknown).toEqual(['deny-redirect']);
    expect(view.shadowed.map((match) => match.id)).toEqual(['allow-deploy']);
    expect(view.reviewReason).toBe('unresolved');
    expect(view.allowMatched).toBe(true);
  });

  test('conditions expose the values and the any/all mode', () => {
    const views = conditionViews(
      rule({
        conditions: [
          condition({
            values: ['test', 'production'],
            matchedValues: ['production'],
            multi: 'all',
          }),
          condition({ target: 'tool', kind: 'exact', pattern: 'deploy' }),
        ],
      }),
    );
    expect(views[0]).toMatchObject({
      multi: 'all',
      values: ['test', 'production'],
      matchedValues: ['production'],
    });
    // A structural condition has no selected values, so no multi mode applies.
    expect(views[1]?.multi).toBeNull();
    expect(views[1]?.values).toEqual([]);
  });
});

describe('rule test staleness', () => {
  const sample = { tool: 'deploy', args: { a: 1 }, input: 'x' };
  const rules = [
    { id: 'one', conditions: [], verdict: 'allow' as RuleVerdict },
  ];

  test('the signature covers the sample, identity and the whole rule list', () => {
    const base = testSignature(sample, 'main', rules, 'one', '/w');
    expect(testSignature(sample, 'main', rules, 'one', '/w')).toBe(base);
    expect(
      testSignature({ ...sample, args: { a: 2 } }, 'main', rules, 'one', '/w'),
    ).not.toBe(base);
    expect(testSignature(sample, 'subagent', rules, 'one', '/w')).not.toBe(
      base,
    );
    expect(
      testSignature(
        sample,
        'main',
        [{ id: 'one', conditions: [], verdict: 'deny' }],
        'one',
        '/w',
      ),
    ).not.toBe(base);
    // Another rule changing is a change: the tester evaluates all of them.
    expect(
      testSignature(
        sample,
        'main',
        [...rules, { id: 'two', conditions: [], verdict: 'deny' }],
        'one',
        '/w',
      ),
    ).not.toBe(base);
    // Focusing another rule changes which conclusion is asked for.
    expect(testSignature(sample, 'main', rules, 'two', '/w')).not.toBe(base);
    // So does evaluation context: a redirect resolves against the cwd.
    expect(testSignature(sample, 'main', rules, 'one', '/other')).not.toBe(
      base,
    );
  });

  test('an issue path resolves to the stable rule of the draft that produced it', () => {
    const rules = [{ id: 'first' }, { id: 'second' }];
    expect(issueTarget('rules[1].conditions[2].path', rules)).toEqual({
      path: 'rules[1].conditions[2].path',
      ruleId: 'second',
      conditionIndex: 2,
    });
    // A rule-level error has no condition.
    expect(issueTarget('rules[0].verdict', rules)).toEqual({
      path: 'rules[0].verdict',
      ruleId: 'first',
      conditionIndex: null,
    });
    // A path outside the array names no rule rather than guessing one.
    expect(issueTarget('rules', rules)).toEqual({
      path: 'rules',
      ruleId: null,
      conditionIndex: null,
    });
    expect(issueTarget('rules[9].id', rules).ruleId).toBeNull();
    // The target is resolved once, when the error arrives, and carried as a
    // stable id. Re-resolving the same index against a shorter draft names no
    // rule rather than silently pointing at a different one.
    expect(issueTarget('rules[1].conditions[0].path', rules)).toEqual({
      path: 'rules[1].conditions[0].path',
      ruleId: 'second',
      conditionIndex: 0,
    });
    const shortened = rules.slice(0, 1);
    expect(issueTarget('rules[1].conditions[0].path', shortened)).toEqual({
      path: 'rules[1].conditions[0].path',
      ruleId: null,
      conditionIndex: 0,
    });
  });

  test('the tool defaults to the rule scope', () => {
    expect(
      defaultTool({
        id: 'x',
        conditions: [],
        verdict: 'allow',
        scope: { tools: ['deploy'] },
      }),
    ).toBe('deploy');
    expect(defaultTool(null)).toBe('bash');
    expect(defaultTool({ id: 'x', conditions: [], verdict: 'allow' })).toBe(
      'bash',
    );
  });
});
