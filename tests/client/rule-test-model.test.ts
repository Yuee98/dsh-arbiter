import { describe, expect, test } from 'vitest';

import {
  buildSample,
  conditionViews,
  coverageDetail,
  coverageView,
  defaultTool,
  finalPath,
  issueTarget,
  priorityView,
  ruleConclusion,
  testSignature,
} from '../../src/client/components/rules/rule-test-model.js';
import { evaluateCall } from '../../src/rules/match.js';
import { nodeTypes } from '../../src/shell/parse.js';
import type { CommandRule } from '../../src/types.js';
import type { RuleTestResultView } from '../../src/client/view-types.js';
import type {
  RuleConditionResult,
  RuleMatchDetail,
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

describe('whole-config precedence', () => {
  function matchOf(overrides: Partial<RuleMatchDetail> = {}): RuleMatchDetail {
    return {
      index: 0,
      id: 'allow-a',
      verdict: 'allow',
      effective: false,
      target: 'command',
      conditionIndex: 0,
      nodeIndex: 0,
      matchedText: 'gh pr view 42',
      ...overrides,
    };
  }

  test('marks the deciding level, the outranked level and the untouched ones', () => {
    const levels = priorityView(
      result({
        path: 'force-ask',
        pathDetail: {
          kind: 'rule',
          verdict: 'force-ask',
          ruleId: 'ask-deploy',
        },
        matches: [
          matchOf({
            id: 'ask-deploy',
            verdict: 'force-ask',
            effective: true,
            matchedText: 'deploy',
          }),
          matchOf({ id: 'allow-a' }),
        ],
        rules: [
          rule({ index: 0, id: 'allow-a', verdict: 'allow' }),
          rule({ index: 1, id: 'ask-deploy', verdict: 'force-ask' }),
        ],
      }),
      'allow-a',
    );
    expect(levels.map((level) => level.verdict)).toEqual([
      'deny',
      'force-ask',
      'force-review',
      'allow',
      null,
    ]);
    expect(levels[1]).toMatchObject({
      decision: 'effective',
      winnerId: 'ask-deploy',
    });
    // A decisive higher-priority rule did beat this allow, so `shadowed` is the
    // truthful label here.
    expect(levels[3]).toMatchObject({
      decision: 'shadowed',
      winnerId: null,
      otherIds: ['allow-a'],
      focused: true,
    });
    expect(levels[0]).toMatchObject({ decision: 'none', focused: false });
    // The fallback never applied here, so it is listed without a claim.
    expect(levels[4]).toEqual({
      kind: 'fallback',
      verdict: null,
      decision: 'none',
      winnerId: null,
      otherIds: [],
      unknownIds: [],
      focused: false,
    });
  });

  test('a review(default) path credits only the fallback level', () => {
    const levels = priorityView(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'no-match' },
        rules: [rule({ outcome: 'no-match' })],
      }),
      'deny-production',
    );
    expect(
      levels.filter((level) => level.decision === 'effective'),
    ).toHaveLength(1);
    expect(levels[4]?.decision).toBe('effective');
    // The marker names where the selected rule sits even though it did not
    // match: hiding it would remove the tier the reader is asking about.
    expect(levels[0]).toMatchObject({ decision: 'none', focused: true });
    expect(levels[1]?.focused).toBe(false);
  });
});

describe('composite-command coverage', () => {
  const compound = result({
    path: 'review(default)',
    pathDetail: { kind: 'review-default', reason: 'partial-allow' },
    normalization: {
      raw: 'gh pr view 42 && rm -rf /tmp/x',
      completeness: 'complete',
      issues: [],
      commands: [
        { text: 'gh pr view 42', raw: 'gh pr view 42', words: [] },
        { text: 'rm -rf /tmp/x', raw: 'rm -rf /tmp/x', words: [] },
      ],
    },
    matches: [
      {
        index: 0,
        id: 'allow-gh',
        verdict: 'allow',
        effective: true,
        target: 'command',
        conditionIndex: 0,
        nodeIndex: 0,
        matchedText: 'gh pr view 42',
      },
    ],
    rules: [
      rule({
        id: 'allow-gh',
        verdict: 'allow',
        conditions: [
          condition({
            target: 'command',
            kind: 'exact',
            pattern: 'gh pr view 42',
            matchedValue: 'gh pr view 42',
          }),
        ],
      }),
    ],
  });

  test('lists every command and marks only the one an allow named', () => {
    const detail = coverageDetail(compound);
    expect(detail.structural).toBe(true);
    expect(detail.total).toBe(2);
    expect(detail.namedCount).toBe(1);
    // The classification is the evaluator's: `partial-allow` says an allow
    // matched without covering everything, which is not something the node list
    // could establish on its own.
    expect(detail.state).toBe('partial');
    expect(detail.nodes).toEqual([
      { index: 0, text: 'gh pr view 42', named: true },
      { index: 1, text: 'rm -rf /tmp/x', named: false },
    ]);
  });

  test('claims whole-call coverage only when every command is named', () => {
    const fullyAllowed = result({
      path: 'allow',
      pathDetail: { kind: 'rule', verdict: 'allow', ruleId: 'allow-gh' },
      normalization: {
        raw: 'gh pr view 42',
        completeness: 'complete',
        issues: [],
        commands: [{ text: 'gh pr view 42', raw: 'gh pr view 42', words: [] }],
      },
      matches: [
        {
          index: 0,
          id: 'allow-gh',
          verdict: 'allow',
          effective: true,
          target: 'command',
          conditionIndex: 0,
          nodeIndex: 0,
          matchedText: 'gh pr view 42',
        },
      ],
      rules: [
        rule({
          id: 'allow-gh',
          verdict: 'allow',
          conditions: [
            condition({
              target: 'command',
              kind: 'exact',
              pattern: 'gh pr view 42',
              matchedValue: 'gh pr view 42',
            }),
          ],
        }),
      ],
    });
    expect(coverageDetail(fullyAllowed)).toMatchObject({
      state: 'complete',
      total: 1,
      namedCount: 1,
    });
  });

  test('absent command evidence is reported as absent, not as a non-shell call', () => {
    // `pwsh` is a shell tool the reader does not parse, so normalization is null.
    // That is not the same as a non-shell tool whose arguments are the whole
    // input, and the panel must not claim the latter.
    const detail = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        normalization: null,
        matches: [],
      }),
    );
    expect(detail).toMatchObject({
      hasEvidence: false,
      structural: false,
      total: 0,
      state: 'unknown-structure',
    });
    expect(detail.nodes).toEqual([]);
  });

  test('an argument condition never counts as naming a shell command', () => {
    // An argument condition matches a selected value; on a shell call that value
    // covers no structural node, so the evaluator still reports partial-allow.
    const detail = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        normalization: {
          raw: 'echo hi',
          completeness: 'complete',
          issues: [],
          commands: [{ text: 'echo hi', raw: 'echo hi', words: [] }],
        },
        rules: [
          rule({
            id: 'allow-argument',
            verdict: 'allow',
            conditions: [
              condition({
                target: 'argument',
                path: '$.command',
                kind: 'exact',
                pattern: 'echo hi',
                matchedValues: ['echo hi'],
              }),
            ],
          }),
        ],
      }),
    );
    expect(detail.namedCount).toBe(0);
    expect(detail.nodes).toEqual([{ index: 0, text: 'echo hi', named: false }]);
  });

  test('a redirect is reported as the uncovered target, not a missing command', () => {
    const detail = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        parse: {
          status: 'ok',
          statements: 1,
          nodes: ['command', 'file_redirect'],
          completeness: 'complete',
          opaque: false,
          unresolved: [],
        },
        normalization: {
          raw: 'echo hi > /tmp/out',
          completeness: 'complete',
          issues: [],
          commands: [{ text: 'echo hi', raw: 'echo hi', words: [] }],
        },
        rules: [
          rule({
            id: 'allow-echo',
            verdict: 'allow',
            conditions: [
              condition({
                target: 'command',
                kind: 'exact',
                pattern: 'echo hi',
                matchedValue: 'echo hi',
              }),
            ],
          }),
        ],
      }),
    );
    // The one command is named, so the cause is the redirect, not a command.
    expect(detail.namedCount).toBe(1);
    expect(detail.otherTargets).toEqual(['file_redirect']);
    expect(detail.state).toBe('partial');
  });

  test('repeated command occurrences are kept, not collapsed by their text', () => {
    const detail = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        normalization: {
          raw: 'echo hi; echo hi',
          completeness: 'complete',
          issues: [],
          commands: [
            { text: 'echo hi', raw: 'echo hi', words: [] },
            { text: 'echo hi', raw: 'echo hi', words: [] },
          ],
        },
      }),
    );
    // Two occurrences ran, so the explanation reports two.
    expect(detail.total).toBe(2);
    expect(detail.nodes.map((node) => node.index)).toEqual([0, 1]);
  });

  test('does not claim coverage for an allow that only ever matched a subset', () => {
    // The exact case the contract names: one allow rule names `echo hi`, and the
    // call is `echo hi; rm -rf /tmp/example`. Both answers mark the allow match
    // as effective, so only the path may decide what the panel says.
    const single = coverageDetail(
      result({
        path: 'allow',
        pathDetail: { kind: 'rule', verdict: 'allow', ruleId: 'allow-echo' },
        normalization: {
          raw: 'echo hi',
          completeness: 'complete',
          issues: [],
          commands: [{ text: 'echo hi', raw: 'echo hi', words: [] }],
        },
        rules: [
          rule({
            id: 'allow-echo',
            verdict: 'allow',
            conditions: [
              condition({
                target: 'command',
                kind: 'exact',
                pattern: 'echo hi',
                matchedValue: 'echo hi',
              }),
            ],
          }),
        ],
      }),
    );
    const compoundCall = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        normalization: {
          raw: 'echo hi; rm -rf /tmp/example',
          completeness: 'complete',
          issues: [],
          commands: [
            { text: 'echo hi', raw: 'echo hi', words: [] },
            {
              text: 'rm -rf /tmp/example',
              raw: 'rm -rf /tmp/example',
              words: [],
            },
          ],
        },
        rules: [
          rule({
            id: 'allow-echo',
            verdict: 'allow',
            conditions: [
              condition({
                target: 'command',
                kind: 'exact',
                pattern: 'echo hi',
                matchedValue: 'echo hi',
              }),
            ],
          }),
        ],
      }),
    );
    expect(single.state).toBe('complete');
    expect(compoundCall.state).toBe('partial');
    // The node list is evidence in both cases; it never sets the classification.
    expect(compoundCall.nodes).toEqual([
      { index: 0, text: 'echo hi', named: true },
      { index: 1, text: 'rm -rf /tmp/example', named: false },
    ]);
  });

  test('an incomplete parse is reported as such, not as an uncovered command', () => {
    const detail = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'incomplete' },
        parse: {
          status: 'error',
          statements: 1,
          nodes: ['command'],
          completeness: 'partial',
          opaque: false,
          unresolved: [],
        },
        normalization: {
          raw: 'echo hi && ',
          completeness: 'partial',
          issues: [],
          commands: [{ text: 'echo hi', raw: 'echo hi', words: [] }],
        },
      }),
    );
    expect(detail.state).toBe('incomplete');
    expect(detail.structural).toBe(true);
  });

  test('a decided non-allow path makes no coverage claim at all', () => {
    for (const verdict of ['deny', 'force-ask', 'force-review'] as const) {
      expect(
        coverageDetail(
          result({
            path: verdict,
            pathDetail: { kind: 'rule', verdict, ruleId: 'r' },
          }),
        ).state,
      ).toBe('not-allow');
    }
  });
});

describe('three-state precedence', () => {
  test('an undetermined higher-priority rule is not reported as a non-match', () => {
    // The integration fixture `echo a > $TARGET`: the deny redirect condition
    // cannot be resolved, the allow matches, and the path is review(unresolved).
    const levels = priorityView(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'unresolved' },
        parse: {
          status: 'ok',
          statements: 1,
          nodes: ['command', 'file_redirect'],
          completeness: 'partial',
          opaque: false,
          unresolved: ['$TARGET'],
        },
        rules: [
          rule({
            index: 0,
            id: 'deny-redirect',
            verdict: 'deny',
            outcome: 'unknown',
            conditions: [
              condition({
                target: 'file_redirect',
                kind: 'glob',
                pattern: '/srv/**',
                outcome: 'unknown',
                reason: 'unresolved-structure',
              }),
            ],
          }),
          rule({
            index: 1,
            id: 'allow-echo',
            verdict: 'allow',
            outcome: 'match',
          }),
        ],
      }),
      null,
    );
    const deny = levels[0];
    // Unknown is its own state: neither a match nor a non-match.
    expect(deny).toMatchObject({
      decision: 'unknown',
      unknownIds: ['deny-redirect'],
    });
    const allow = levels[3];
    // The allow matched conclusively; an undetermined higher-priority rule is
    // what withheld it. That is not the allow's own outcome.
    expect(allow).toMatchObject({
      decision: 'withheld-by-unknown',
      otherIds: ['allow-echo'],
      unknownIds: [],
    });
    expect(levels[4]?.decision).toBe('effective');
  });

  test('a partial-allow fallback is not described as priority shadowing', () => {
    const levels = priorityView(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        rules: [rule({ id: 'allow-gh', verdict: 'allow', outcome: 'match' })],
      }),
      null,
    );
    // No higher-priority rule matched, so calling this "outranked" would state
    // a cause the evaluator never gave.
    expect(levels[3]).toMatchObject({
      decision: 'insufficient-coverage',
      otherIds: ['allow-gh'],
    });
  });

  test('only the credited rule is effective when a tier has several matches', () => {
    const levels = priorityView(
      result({
        path: 'deny',
        pathDetail: { kind: 'rule', verdict: 'deny', ruleId: 'deny-first' },
        rules: [
          rule({
            index: 0,
            id: 'deny-first',
            verdict: 'deny',
            outcome: 'match',
          }),
          rule({
            index: 1,
            id: 'deny-second',
            verdict: 'deny',
            outcome: 'match',
          }),
        ],
      }),
      null,
    );
    expect(levels[0]).toMatchObject({
      decision: 'tier-match',
      winnerId: 'deny-first',
      otherIds: ['deny-second'],
    });
  });
});

/**
 * A decoded route answer for one real evaluation.
 *
 * The explanation layer must not invent facts, so a few tests run the actual
 * evaluator and decode its answer the way the browser does, instead of hand
 * writing the fields the panel is about to read.
 */
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function decoded(
  rules: readonly CommandRule[],
  tool: string,
  args: unknown,
  cwd = '/w',
): RuleTestResultView {
  const evaluation = evaluateCall({
    rules,
    tool,
    arguments: args,
    identity: 'main',
    workspaceRoot: cwd,
    cwd,
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });
  return {
    input:
      typeof args === 'object' && args !== null && 'command' in args
        ? text(args['command'])
        : '',
    tool,
    cwd,
    path:
      evaluation.path.kind === 'rule'
        ? evaluation.path.verdict
        : 'review(default)',
    pathDetail: evaluation.path,
    rule: evaluation.matches.find((match) => match.effective) ?? null,
    matches: evaluation.matches,
    rules: evaluation.rules,
    parse: {
      status: evaluation.parse.status,
      statements: evaluation.parse.statements,
      nodes: nodeTypes(evaluation.parse),
      completeness: evaluation.parse.completeness,
      opaque: evaluation.parse.opaque,
      unresolved: evaluation.parse.unresolved,
    },
    argv: evaluation.argv,
    normalization: evaluation.normalization,
    shadowed: evaluation.shadowed,
  };
}

describe('review round two corrections', () => {
  const echoAllow = (matchedValues: readonly string[]) =>
    rule({
      id: 'allow-echo',
      verdict: 'allow',
      conditions: [
        condition({
          target: 'command',
          kind: 'regex',
          pattern: 'echo .*',
          matchedValues,
          // `exactOptionalPropertyTypes` separates an absent key from an
          // explicit `undefined`, so an empty list omits the field entirely.
          ...(matchedValues[0] === undefined
            ? {}
            : { matchedValue: matchedValues[0] }),
        }),
      ],
    });

  test('a condition that matched two commands names both of them', () => {
    // `echo a; echo b` against `echo .*`: the evaluator credits both, so the
    // explanation must not stop at the first matched text.
    const detail = coverageDetail(
      result({
        path: 'allow',
        pathDetail: { kind: 'rule', verdict: 'allow', ruleId: 'allow-echo' },
        normalization: {
          raw: 'echo a; echo b',
          completeness: 'complete',
          issues: [],
          commands: [
            { text: 'echo a', raw: 'echo a', words: [] },
            { text: 'echo b', raw: 'echo b', words: [] },
          ],
        },
        rules: [echoAllow(['echo a', 'echo b'])],
      }),
    );
    expect(detail.namedCount).toBe(2);
    expect(detail.nodes.map((node) => node.named)).toEqual([true, true]);
  });

  test('a matched allow withheld by an unknown higher priority is not called unknown', () => {
    const levels = priorityView(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'unresolved' },
        rules: [
          rule({
            index: 0,
            id: 'deny-redirect',
            verdict: 'deny',
            outcome: 'unknown',
          }),
          rule({
            index: 1,
            id: 'allow-echo',
            verdict: 'allow',
            outcome: 'match',
          }),
        ],
      }),
      'allow-echo',
    );
    expect(levels[0]).toMatchObject({
      decision: 'unknown',
      unknownIds: ['deny-redirect'],
    });
    expect(levels[3]).toMatchObject({
      decision: 'withheld-by-unknown',
      otherIds: ['allow-echo'],
    });
  });

  test('a second allow beside the credited one is neither shadowed nor credited', () => {
    // `echo a; echo b` matched both allow rules. The answer names allow-a but does
    // not publish which rule covered which command, so allow-b is neither proven
    // outranked nor proven to have supplied the missing coverage.
    const view = coverageView(
      result({
        path: 'allow',
        pathDetail: { kind: 'rule', verdict: 'allow', ruleId: 'allow-a' },
        matches: [
          {
            index: 0,
            id: 'allow-a',
            verdict: 'allow',
            effective: true,
            target: 'command',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'echo a',
          },
          {
            index: 1,
            id: 'allow-b',
            verdict: 'allow',
            effective: false,
            target: 'command',
            conditionIndex: 0,
            nodeIndex: 1,
            matchedText: 'echo b',
          },
        ],
      }),
    );
    expect(view.shadowed).toEqual([]);
    expect(view.additionalAllows.map((match) => match.id)).toEqual(['allow-b']);
  });

  test('an allow beaten by a deny is still reported as shadowed', () => {
    const view = coverageView(
      result({
        path: 'deny',
        pathDetail: { kind: 'rule', verdict: 'deny', ruleId: 'deny-x' },
        matches: [
          {
            index: 0,
            id: 'deny-x',
            verdict: 'deny',
            effective: true,
            target: 'command',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'echo a',
          },
          {
            index: 1,
            id: 'allow-a',
            verdict: 'allow',
            effective: false,
            target: 'command',
            conditionIndex: 0,
            nodeIndex: 0,
            matchedText: 'echo a',
          },
        ],
      }),
    );
    expect(view.shadowed.map((match) => match.id)).toEqual(['allow-a']);
    expect(view.additionalAllows).toEqual([]);
  });

  test('a parsed call with no command is distinguished from an unparsed one', () => {
    const redirectOnly = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'partial-allow' },
        parse: {
          status: 'ok',
          statements: 1,
          nodes: ['file_redirect'],
          completeness: 'complete',
          opaque: false,
          unresolved: [],
        },
        normalization: {
          raw: '> /tmp/out',
          completeness: 'complete',
          issues: [],
          commands: [],
        },
      }),
    );
    expect(redirectOnly.parsed).toBe(true);
    expect(redirectOnly.hasEvidence).toBe(true);
    expect(redirectOnly.structural).toBe(false);
    expect(redirectOnly.otherTargets).toEqual(['file_redirect']);
  });

  test('a failed parse is not reported as a successful one', () => {
    // `if then fi` fails to parse; the evaluator still publishes a normalization
    // whose command list is empty. Evidence exists, but calling that "parsed
    // successfully with nothing to list" would invent a structure nobody read.
    const failed = coverageDetail(
      result({
        path: 'review(default)',
        pathDetail: { kind: 'review-default', reason: 'incomplete' },
        parse: {
          status: 'error',
          statements: 0,
          nodes: [],
          completeness: 'none',
          opaque: true,
          unresolved: [],
        },
        normalization: {
          raw: 'if then fi',
          completeness: 'none',
          issues: [
            { kind: 'parse-error', message: 'expected command', pos: 3 },
          ],
          commands: [],
        },
      }),
    );
    expect(failed.hasEvidence).toBe(true);
    expect(failed.structural).toBe(false);
    expect(failed.parsed).toBe(false);
  });

  test('the real evaluator names both commands one condition matched', () => {
    // `echo .*` matches both commands, and the evaluator returns both in
    // `matchedValues`. Reading only the first would mark `echo b` unnamed while
    // the same answer reports the whole call as allowed.
    const real = decoded(
      [
        {
          id: 'allow-echo',
          verdict: 'allow',
          enabled: true,
          combine: 'any',
          conditions: [
            { target: 'command', kind: 'regex', pattern: 'echo .*' },
          ],
        },
      ],
      'bash',
      { command: 'echo a; echo b' },
    );
    expect(finalPath(real).kind).toBe('rule');
    const detail = coverageDetail(real);
    expect(detail.total).toBe(2);
    expect(detail.namedCount).toBe(2);
    expect(detail.nodes.map((node) => node.named)).toEqual([true, true]);
    expect(detail.state).toBe('complete');
  });

  test('the real evaluator publishes evidence for a failed parse', () => {
    // `if then fi` fails to parse, yet normalization is not null; only the parse
    // status distinguishes "nothing was read" from "read and found no command".
    const real = decoded(
      [
        {
          id: 'allow-echo',
          verdict: 'allow',
          enabled: true,
          combine: 'any',
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo hi' },
          ],
        },
      ],
      'bash',
      { command: 'if then fi' },
    );
    const detail = coverageDetail(real);
    expect(detail.hasEvidence).toBe(true);
    expect(detail.parsed).toBe(false);
    expect(detail.structural).toBe(false);
  });

  test('the real evaluator with an unparsed dialect publishes no evidence', () => {
    // `pwsh` is a shell tool whose dialect is not read, so normalization is null.
    // The evaluator still returns a synthetic empty parse, which is why the panel
    // decides on `hasEvidence` first: `parsed` alone would describe a read that
    // never happened.
    const real = decoded([], 'pwsh', { command: 'echo hi' });
    const detail = coverageDetail(real);
    expect(detail.hasEvidence).toBe(false);
    expect(detail.nodes).toEqual([]);
    expect(detail.structural).toBe(false);
  });
});
