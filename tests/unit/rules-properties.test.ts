import fc from 'fast-check';
import { describe, expect, test } from 'vitest';

import { evaluateCall } from '../../src/rules/match.js';
import type { CommandRule, RuleVerdict } from '../../src/types.js';

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
    match: { node: 'tool', kind: 'exact', pattern: tool, tool },
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
