import { describe, expect, it } from 'vitest';

import zhRules from '../locale/zh/rules.json' with { type: 'json' };
import {
  addDuplicate,
  addRule,
  canMoveRule,
  convertExactPattern,
  defaultCondition,
  duplicateRule,
  exactType,
  moveRule,
  moveTarget,
  nextRuleId,
  ruleIssues,
  ruleName,
  ruleSummary,
} from '../src/client/components/rules/draft.js';
import type { Translate } from '../src/client/i18n.js';
import type { Draft, DraftRule } from '../src/client/view-types.js';

/** Flatten the real Chinese catalog and interpolate, like the host adapter. */
function catalog(
  tree: Record<string, unknown>,
  prefix = '',
): Map<string, string> {
  const messages = new Map<string, string>();
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix.length === 0 ? key : `${prefix}.${key}`;
    if (typeof value === 'string') messages.set(full, value);
    else if (typeof value === 'object')
      for (const [inner, text] of catalog({ ...value }, full))
        messages.set(inner, text);
  }
  return messages;
}

const messages = catalog({ ...zhRules }, 'rules');
const t: Translate = (key, params) => {
  const template = messages.get(key) ?? key;
  return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
    params?.[name] === undefined ? match : String(params[name]),
  );
};

function draft(rules: readonly DraftRule[] = []): Draft {
  return {
    enabled: true,
    boundary: 'guarded',
    modes: { main: 'normal', subagent: 'strict' },
    rules: rules.map((rule) => ({
      ...rule,
      conditions: rule.conditions.map((condition) => ({ ...condition })),
    })),
    reviewer: {
      type: 'chat',
      chat: {
        provider: 'session',
        model: '',
        temperature: 0,
        maxTokens: 400,
        timeoutMs: 8000,
        maxRepairRetries: 1,
      },
      decision: {
        url: '',
        model: 'clef-flash',
        apiKeyRef: 'TOKEN',
        timeoutMs: 8000,
        costTier: 'paid',
      },
    },
    policy: {
      version: 'arbiter-policy-v1',
      normal: {
        tauAuth: 0.8,
        tauRisk: 0.75,
        tauCritical: 0.25,
        tauLow: 0.7,
        chatLowRiskMax: 3,
        chatMediumRiskMax: 6,
        mediumRiskCeiling: 6,
        explicitFromRisk: 4,
        allowBulkEgress: false,
      },
      progress: {
        tauAuth: 0.8,
        tauRisk: 0.75,
        tauCritical: 0.25,
        tauLow: 0.7,
        chatLowRiskMax: 3,
        chatMediumRiskMax: 8,
        mediumRiskCeiling: 8,
        explicitFromRisk: 4,
        allowBulkEgress: true,
      },
      probeMode: 'assist',
    },
    context: {
      maxInputTokens: 10_000,
      evidenceMaxItems: 20,
      parentHumanItems: 5,
      parentEvidenceFloor: 1,
      historyMaxItems: 40,
      checkpointMaxItems: 3,
      toolCallArgumentMaxChars: 200,
      customRules: '',
      projectRules: { enabled: true, files: [] },
    },
    audit: {
      enabled: true,
      retentionDays: 30,
      retentionBytes: 1024,
      maxQueue: 500,
    },
    breaker: {
      mode: 'preset',
      preset: 'balanced',
      consecutiveDenials: 3,
      windowDenials: 6,
      windowSize: 10,
    },
    reviewBudget: null,
  };
}

function rule(overrides: Partial<DraftRule> = {}): DraftRule {
  return {
    id: 'rule-1',
    conditions: [{ target: 'command', kind: 'regex', pattern: 'gh pr view' }],
    verdict: 'force-review',
    enabled: true,
    ...overrides,
  };
}

describe('draft rule defaults', () => {
  it('starts new rules enabled with force-review and the safe match mode', () => {
    const created = addRule(draft());
    expect(created).toMatchObject({
      id: 'rule-1',
      verdict: 'force-review',
      enabled: true,
      conditions: [{ target: 'command', kind: 'regex', pattern: '' }],
    });
  });

  it('uses exact matching for a tool-argument default condition', () => {
    expect(defaultCondition('argument')).toEqual({
      target: 'argument',
      kind: 'exact',
      pattern: '',
    });
  });

  it('declares the canonical format once a rule enters the draft', () => {
    const current = draft();
    expect(current.format).toBeUndefined();
    addRule(current);
    expect(current.format).toBe('arbiter-config-v2');
  });

  it('keeps ids unique and stable across renames and edits', () => {
    const current = draft();
    const first = addRule(current);
    const copy = addDuplicate(current, first);
    expect(first.id).not.toBe(copy.id);
    // The source keeps its id; the copy is the one that changed.
    expect(current.rules[0]?.id).toBe(first.id);
    expect(current.rules[1]?.id).toBe(copy.id);
    expect(nextRuleId(current.rules)).toBe('rule-3');
  });
});

describe('duplicate', () => {
  it('copies scope, conditions, verdict and comment but starts disabled', () => {
    const source = rule({
      scope: { tools: ['bash'], agents: ['main'] },
      conditions: [
        { target: 'argument', path: '$.env', kind: 'exact', pattern: 'prod' },
      ],
      verdict: 'deny',
      comment: 'production',
      hint: 'check target',
    });
    const copy = duplicateRule(source, [source]);
    expect(copy).toMatchObject({
      verdict: 'deny',
      enabled: false,
      comment: 'production',
      hint: 'check target',
      scope: { tools: ['bash'], agents: ['main'] },
      conditions: [
        { target: 'argument', path: '$.env', kind: 'exact', pattern: 'prod' },
      ],
    });
    expect(copy.id).not.toBe(source.id);
  });

  it('does not alias the source conditions', () => {
    const source = rule();
    const copy = duplicateRule(source, [source]);
    const first = copy.conditions[0];
    if (first === undefined) throw new Error('the copy has no condition');
    first.pattern = 'changed';
    expect(source.conditions[0]?.pattern).toBe('gh pr view');
  });
});

describe('ordering', () => {
  it('moves to the nearest rule with the same verdict', () => {
    const rules = [
      rule({ id: 'a', verdict: 'allow' }),
      rule({ id: 'x', verdict: 'deny' }),
      rule({ id: 'b', verdict: 'allow' }),
    ];
    // A and B share a priority, so B may step past the deny rule to reach A.
    expect(moveTarget(rules, 2, -1)).toBe(0);
    expect(canMoveRule(rules, 2, -1)).toBe(true);
    expect(moveTarget(rules, 2, 1)).toBeNull();

    moveRule(rules, 2, -1);
    // The two same-priority rules swap; the deny rule keeps its position.
    expect(rules.map((entry) => entry.id)).toEqual(['b', 'x', 'a']);
  });

  it('never crosses into another verdict priority', () => {
    const rules = [
      rule({ id: 'a', verdict: 'deny' }),
      rule({ id: 'b', verdict: 'deny' }),
      rule({ id: 'c', verdict: 'allow' }),
    ];
    expect(canMoveRule(rules, 1, 1)).toBe(false);
    expect(canMoveRule(rules, 2, -1)).toBe(false);
    expect(moveTarget(rules, 0, 1)).toBe(1);

    moveRule(rules, 0, 1);
    expect(rules.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
    // A denied move keeps the list unchanged.
    moveRule(rules, 1, 1);
    expect(rules.map((entry) => entry.id)).toEqual(['b', 'a', 'c']);
  });
});

describe('exact value types', () => {
  it('reports the JSON type of an exact pattern', () => {
    expect(exactType(null)).toBe('null');
    expect(exactType(3)).toBe('number');
    expect(exactType(false)).toBe('boolean');
    expect(exactType('text')).toBe('string');
  });

  it('converts parseable literals instead of reversing them', () => {
    // Choosing the boolean type must not turn `"true"` into `false`.
    expect(convertExactPattern('true', 'boolean')).toBe(true);
    expect(convertExactPattern('false', 'boolean')).toBe(false);
    expect(convertExactPattern('42', 'number')).toBe(42);
    expect(convertExactPattern('-1.5', 'number')).toBe(-1.5);
    expect(convertExactPattern(7, 'string')).toBe('7');
    expect(convertExactPattern(true, 'string')).toBe('true');
    expect(convertExactPattern(null, 'string')).toBe('null');
  });

  it('leaves an unrepresentable value alone rather than inventing a match', () => {
    // `0` would be a valid but unrelated expression, so the text is kept.
    expect(convertExactPattern('not-a-number', 'number')).toBe('not-a-number');
    expect(convertExactPattern('yes', 'boolean')).toBe('yes');
    expect(convertExactPattern(7, 'null')).toBeNull();
  });

  it('keeps a blank expression blank instead of inserting a value', () => {
    // A blank pattern has no type to carry over; the editor tracks the chosen
    // type locally so the user still gets the matching value editor.
    expect(convertExactPattern('', 'number')).toBe('');
    expect(convertExactPattern('', 'boolean')).toBe('');
    expect(convertExactPattern('', 'string')).toBe('');
    expect(convertExactPattern('', 'null')).toBeNull();
  });
});

describe('automatic summary and custom names', () => {
  it('follows the first condition and counts the alternatives', () => {
    const one = rule();
    expect(ruleName(one, t)).toBe('命令 RE2：gh pr view');

    const many = rule({
      conditions: [
        { target: 'command', kind: 'regex', pattern: 'gh pr view' },
        { target: 'tool', kind: 'exact', pattern: 'bash' },
      ],
    });
    expect(ruleSummary(many, t)).toBe('命令 RE2：gh pr view 等 2 个条件');
  });

  it('prefixes the scope and marks case-insensitive conditions', () => {
    const scoped = rule({
      scope: { tools: ['bash'] },
      conditions: [
        {
          target: 'command',
          kind: 'regex',
          pattern: 'gh pr view',
          caseSensitive: false,
        },
      ],
    });
    expect(ruleSummary(scoped, t)).toBe(
      'bash · 命令 RE2：gh pr view（忽略大小写）',
    );
  });

  it('says a rule has no conditions rather than showing an empty summary', () => {
    expect(ruleSummary(rule({ conditions: [] }), t)).toBe('尚未设置条件');
  });

  it('prefers a custom name and falls back when it is cleared', () => {
    const named = rule({ name: '只读查询' });
    expect(ruleName(named, t)).toBe('只读查询');
    expect(ruleName(rule({ name: '   ' }), t)).toBe('命令 RE2：gh pr view');
  });
});

describe('validation feedback routing', () => {
  it('attaches indexed errors to the rule at that position', () => {
    const issues = ruleIssues(
      [
        {
          issue: {
            path: 'rules[1].conditions[0].path',
            message: 'invalid JSONPath',
            code: 'rule.path-invalid',
          },
          field: '',
          severity: 'error',
        },
        {
          issue: {
            path: 'rules[0].conditions',
            message: 'needs a condition',
            code: 'rule.conditions-empty',
          },
          field: '',
          severity: 'error',
        },
        {
          issue: { path: 'reviewer.url', message: 'unrelated' },
          field: '',
          severity: 'error',
        },
      ],
      rule({ id: 'rule-2' }),
      1,
    );
    expect(issues.map((entry) => entry.issue.path)).toEqual([
      'rules[1].conditions[0].path',
    ]);
    // The relative field drops the rule prefix so the editor can locate it.
    expect(issues[0]?.field).toBe('conditions[0].path');
  });

  it('matches a warning by the exact rule id, not by list position', () => {
    const warnings = [
      {
        issue: {
          path: 'rules.rule-1',
          message: 'shadowed',
          code: 'rule.shadowed',
        },
        field: '',
        severity: 'warning' as const,
      },
    ];
    const attached = ruleIssues(warnings, rule({ id: 'rule-1' }), 3);
    expect(attached.map((entry) => entry.issue.code)).toEqual([
      'rule.shadowed',
    ]);
    expect(attached[0]?.field).toBe('rule-1');
    // A different rule id does not inherit the warning.
    expect(ruleIssues(warnings, rule({ id: 'rule-2' }), 0)).toEqual([]);
  });

  it('does not let a dotted id read another rule id as a field path', () => {
    // The backend addresses a shadowing warning as `rules.<allow id>`. For ids
    // `a` and `a.b`, a prefix match would show one warning on both rules.
    const warnings = [
      {
        issue: {
          path: 'rules.a.b',
          message: 'shadowed',
          code: 'rule.shadowed',
        },
        field: '',
        severity: 'warning' as const,
      },
    ];
    expect(ruleIssues(warnings, rule({ id: 'a' }), 0)).toEqual([]);
    expect(
      ruleIssues(warnings, rule({ id: 'a.b' }), 1).map(
        (entry) => entry.issue.code,
      ),
    ).toEqual(['rule.shadowed']);
  });
});
