import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { evaluateCall } from '../../src/rules/match.js';
import type {
  CommandRule,
  RuleCondition,
  RuleVerdict,
} from '../../src/types.js';

const toolName = fc.constantFrom('read', 'bash', 'run_code', 'mcp.fs.read');
const otherRule = fc.record({
  verdict: fc.constantFrom<RuleVerdict>(
    'allow',
    'deny',
    'force-ask',
    'force-review',
  ),
  enabled: fc.boolean(),
  matching: fc.boolean(),
});

function toolRule(
  id: string,
  verdict: RuleVerdict,
  tool: string,
  enabled = true,
): CommandRule {
  return {
    id,
    enabled,
    verdict,
    conditions: [{ target: 'tool', kind: 'exact', pattern: tool }],
  };
}

function evaluate(rules: readonly CommandRule[], tool: string) {
  return evaluateCall({
    rules,
    tool,
    arguments: { command: 'echo hello', path: '/workspace/app/file.txt' },
    identity: 'main',
    workspaceRoot: '/workspace/app',
    cwd: '/workspace/app',
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });
}

/** Two arbitrary alternatives over the same structural target. */
const conditionPair = fc.tuple(
  fc.record({
    kind: fc.constantFrom('exact' as const, 'regex' as const, 'glob' as const),
    pattern: fc.constantFrom('echo hello', 'echo(?: .*)?', 'echo*', 'rm -rf /'),
  }),
  fc.record({
    kind: fc.constantFrom('exact' as const, 'regex' as const, 'glob' as const),
    pattern: fc.constantFrom('echo hello', 'echo(?: .*)?', 'echo*', 'rm -rf /'),
  }),
);

const asCondition = (entry: {
  readonly kind: 'exact' | 'regex' | 'glob';
  readonly pattern: string;
}): RuleCondition => ({
  target: 'command',
  kind: entry.kind,
  pattern: entry.pattern,
});

describe('rule priority properties', () => {
  test('a matching enabled deny dominates other verdicts regardless of rule order', () => {
    fc.assert(
      fc.property(
        toolName,
        fc.array(otherRule, { maxLength: 24 }),
        fc.nat(),
        (tool, others, placement) => {
          const rules = others.map((entry, index) =>
            toolRule(
              `other-${String(index)}`,
              entry.verdict,
              entry.matching ? tool : `unmatched-${tool}`,
              entry.enabled,
            ),
          );
          rules.splice(
            placement % (rules.length + 1),
            0,
            toolRule('required-deny', 'deny', tool),
          );

          for (const order of [rules, rules.toReversed()]) {
            expect(evaluate(order, tool).path).toMatchObject({
              kind: 'rule',
              verdict: 'deny',
            });
          }
        },
      ),
      { numRuns: 100 },
    );
  });

  test('disabled higher-priority rules cannot shadow an enabled whole-tool allow', () => {
    fc.assert(
      fc.property(
        toolName,
        fc.array(
          fc.constantFrom<Exclude<RuleVerdict, 'allow'>>(
            'deny',
            'force-ask',
            'force-review',
          ),
          { minLength: 1, maxLength: 24 },
        ),
        fc.nat(),
        (tool, disabledVerdicts, placement) => {
          const rules: CommandRule[] = disabledVerdicts.map((verdict, index) =>
            toolRule(`disabled-${String(index)}`, verdict, tool, false),
          );
          rules.splice(
            placement % (rules.length + 1),
            0,
            toolRule('enabled-allow', 'allow', tool),
          );

          for (const order of [rules, rules.toReversed()]) {
            const result = evaluate(order, tool);
            expect(result.path).toEqual({
              kind: 'rule',
              verdict: 'allow',
              ruleId: 'enabled-allow',
            });
            expect(result.matches.map((match) => match.id)).toEqual([
              'enabled-allow',
            ]);
          }
        },
      ),
      { numRuns: 100 },
    );
  });
});

describe('condition properties', () => {
  test('alternatives are commutative: the rule matches in either order', () => {
    fc.assert(
      fc.property(conditionPair, ([left, right]) => {
        const ruleIn = (conditions: readonly RuleCondition[]): CommandRule => ({
          id: 'or',
          verdict: 'deny',
          conditions,
        });
        const forward = evaluateCall({
          rules: [ruleIn([asCondition(left), asCondition(right)])],
          tool: 'bash',
          arguments: { command: 'echo hello' },
          identity: 'main',
          workspaceRoot: '/w',
          cwd: '/w',
          parentAuthorizationPresent: null,
          historyTruncated: false,
          overlapsDeniedEffect: false,
        });
        const reverse = evaluateCall({
          rules: [ruleIn([asCondition(right), asCondition(left)])],
          tool: 'bash',
          arguments: { command: 'echo hello' },
          identity: 'main',
          workspaceRoot: '/w',
          cwd: '/w',
          parentAuthorizationPresent: null,
          historyTruncated: false,
          overlapsDeniedEffect: false,
        });
        expect(forward.rules[0]?.outcome).toBe(reverse.rules[0]?.outcome);
      }),
      { numRuns: 100 },
    );
  });

  test('all implies any for the same selection and pattern', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', '/etc'), { maxLength: 4 }),
        (values) => {
          const make = (multi: 'any' | 'all'): CommandRule => ({
            id: `multi-${multi}`,
            verdict: 'deny',
            conditions: [
              {
                target: 'argument',
                path: '$[*]',
                kind: 'exact',
                pattern: 'a',
                multi,
              },
            ],
          });
          const run = (multi: 'any' | 'all') =>
            evaluateCall({
              rules: [make(multi)],
              tool: 'probe',
              arguments: values,
              identity: 'main',
              workspaceRoot: '/w',
              cwd: '/w',
              parentAuthorizationPresent: null,
              historyTruncated: false,
              overlapsDeniedEffect: false,
            }).rules[0]?.outcome;
          const any = run('any');
          const all = run('all');
          // Express the implication without a conditional assertion: `all`
          // matching must imply `any` matching, and `any` failing must imply
          // `all` failing.
          const implies = (left: boolean, right: boolean): boolean =>
            !left || right;
          expect(implies(all === 'match', any === 'match')).toBe(true);
          expect(implies(any === 'no-match', all === 'no-match')).toBe(true);
        },
      ),
      { numRuns: 100 },
    );
  });

  test('an empty selection never matches, in either mode', () => {
    for (const multi of ['any', 'all'] as const) {
      const evaluation = evaluateCall({
        rules: [
          {
            id: 'empty',
            verdict: 'deny',
            conditions: [
              {
                target: 'argument',
                path: '$.missing[*]',
                kind: 'exact',
                pattern: 'x',
                multi,
              },
            ],
          },
        ],
        tool: 'probe',
        arguments: { present: ['x'] },
        identity: 'main',
        workspaceRoot: '/w',
        cwd: '/w',
        parentAuthorizationPresent: null,
        historyTruncated: false,
        overlapsDeniedEffect: false,
      });
      expect(evaluation.rules[0]?.outcome).toBe('no-match');
      expect(evaluation.rules[0]?.conditions[0]?.reason).toBe(
        'empty-selection',
      );
    }
  });
});
