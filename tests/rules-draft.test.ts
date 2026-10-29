import { describe, expect, it } from 'vitest';

import zhRules from '../locale/zh/rules.json' with { type: 'json' };
import {
  addDuplicate,
  addRule,
  canMoveRule,
  convertExactPattern,
  clearRulePendingExact,
  defaultCondition,
  duplicateRule,
  exactType,
  moveRule,
  moveTarget,
  nextRuleId,
  PRIORITY_ENTRIES,
  isAdvancedCondition,
  pendingExactIssues,
  pendingExactKey,
  rebasePendingExactOnRemoveCondition,
  reorderRuleWithinVerdict,
  ruleIssues,
  ruleName,
  ruleSummary,
  scopeLabel,
  scopeView,
  setPendingExactType,
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
    modes: { main: 'ask', subagent: 'no-ask' },
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
      version: 'arbiter-policy-v3',
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
  it('starts new rules enabled with force-review and exact matching', () => {
    const created = addRule(draft());
    expect(created).toMatchObject({
      id: 'rule-1',
      verdict: 'force-review',
      enabled: true,
      conditions: [{ target: 'command', kind: 'exact', pattern: '' }],
      // Adding a condition should narrow a rule, so a new rule combines with
      // "all" even before a second condition exists.
      combine: 'all',
    });
  });

  it('uses exact matching for every default condition target', () => {
    // Exact is the only kind whose meaning needs no knowledge of a matching
    // dialect, so it is the ordinary entry point for every target.
    for (const target of [
      'command',
      'file_redirect',
      'variable_assignment',
      'tool',
      'argument',
    ] as const) {
      expect(defaultCondition(target)).toEqual({
        target,
        kind: 'exact',
        pattern: '',
      });
    }
  });

  it('keeps the fixed precedence in evaluator order', () => {
    // The order is a product contract: deny > force-ask > force-review > allow,
    // with review(default) as the fallback rather than a configurable verdict.
    expect(
      PRIORITY_ENTRIES.map((entry) =>
        entry.kind === 'fallback' ? 'review(default)' : entry.verdict,
      ),
    ).toEqual([
      'deny',
      'force-ask',
      'force-review',
      'allow',
      'review(default)',
    ]);
  });

  it('declares the canonical format once a rule enters the draft', () => {
    const current = draft();
    expect(current.format).toBeUndefined();
    addRule(current);
    expect(current.format).toBe('arbiter-config-v3');
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
      combine: 'any',
      conditions: [
        { target: 'command', kind: 'regex', pattern: 'gh pr view' },
        { target: 'tool', kind: 'exact', pattern: 'bash' },
      ],
    });
    // The connective belongs in the name: two conditions under `any` and two
    // under `all` are different rules with the same expressions.
    expect(ruleSummary(many, t)).toBe(
      '命令 RE2：gh pr view 等 2 个条件（任一满足）',
    );
    const conjunctive = rule({
      combine: 'all',
      conditions: many.conditions,
    });
    expect(ruleSummary(conjunctive, t)).toBe(
      '命令 RE2：gh pr view 等 2 个条件（全部满足）',
    );
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

  describe('reorderRuleWithinVerdict', () => {
    it('reorders rules within the same verdict while preserving interleaved slots', () => {
      const r1: DraftRule = { ...rule({ id: 'deny-1' }), verdict: 'deny' };
      const r2: DraftRule = { ...rule({ id: 'allow-1' }), verdict: 'allow' };
      const r3: DraftRule = { ...rule({ id: 'deny-2' }), verdict: 'deny' };
      const r4: DraftRule = {
        ...rule({ id: 'force-ask-1' }),
        verdict: 'force-ask',
      };
      const r5: DraftRule = { ...rule({ id: 'deny-3' }), verdict: 'deny' };

      const rules = [r1, r2, r3, r4, r5];
      const result = reorderRuleWithinVerdict(rules, 'deny-3', 'deny-1');
      expect(result).toBe(true);
      expect(rules.map((r) => r.id)).toEqual([
        'deny-3',
        'allow-1',
        'deny-1',
        'force-ask-1',
        'deny-2',
      ]);
    });

    it('returns false and does not mutate rules on cross-verdict drop', () => {
      const r1: DraftRule = { ...rule({ id: 'deny-1' }), verdict: 'deny' };
      const r2: DraftRule = { ...rule({ id: 'allow-1' }), verdict: 'allow' };
      const rules = [r1, r2];
      const result = reorderRuleWithinVerdict(rules, 'deny-1', 'allow-1');
      expect(result).toBe(false);
      expect(rules.map((r) => r.id)).toEqual(['deny-1', 'allow-1']);
    });
  });

  describe('pendingExactType lifecycle', () => {
    it('manages pending type and rebases correctly on condition removal', () => {
      let map = {};
      map = setPendingExactType(map, 'rule-1', 0, 'number');
      map = setPendingExactType(map, 'rule-1', 1, 'boolean');
      expect(map).toEqual({
        'rule-1:0': 'number',
        'rule-1:1': 'boolean',
      });

      // Remove condition 0: condition 1 should rebase to index 0
      map = rebasePendingExactOnRemoveCondition(map, 'rule-1', 0);
      expect(map).toEqual({
        'rule-1:0': 'boolean',
      });

      // Clear rule pending
      map = clearRulePendingExact(map, 'rule-1');
      expect(map).toEqual({});
    });

    it('emits canonical issues for incomplete pending exact conditions', () => {
      const testDraft = draft([
        {
          id: 'rule-1',
          combine: 'all',
          conditions: [
            { target: 'argument', kind: 'exact', pattern: '' },
            { target: 'argument', kind: 'exact', pattern: '' },
          ],
          verdict: 'allow',
          enabled: true,
          comment: '',
        },
      ]);
      const map = {
        [pendingExactKey('rule-1', 0)]: 'number' as const,
      };
      const issues = pendingExactIssues(testDraft, map, 'incomplete');
      expect(issues).toEqual([
        {
          path: 'rules[0].conditions[0].pattern',
          message: 'incomplete',
        },
      ]);
    });
  });
});

describe('scope and condition reach', () => {
  it('states an unlimited scope instead of implying nothing applies', () => {
    const view = scopeView(rule());
    expect(view).toEqual({ kind: 'unscoped', tools: [], agents: [] });
    expect(scopeLabel(view, t)).toMatch(/^未限定范围/);
  });

  it('names the entries that do limit the scope, tools before agents', () => {
    const view = scopeView(
      rule({ scope: { tools: ['bash', 'deploy'], agents: ['main'] } }),
    );
    expect(view.kind).toBe('scoped');
    expect(scopeLabel(view, t)).toBe(
      '限定范围：工具 bash, deploy · agent main',
    );

    // One dimension alone is enough to limit the rule.
    const toolsOnly = scopeView(rule({ scope: { tools: ['bash'] } }));
    expect(scopeLabel(toolsOnly, t)).toBe('限定范围：工具 bash');
    const agentsOnly = scopeView(rule({ scope: { agents: ['subagent'] } }));
    expect(scopeLabel(agentsOnly, t)).toBe('限定范围：agent subagent');
  });

  it('treats an empty scope object as unlimited', () => {
    // The schema rejects an empty list, but a draft read from an older editor
    // could carry one; the label must not claim a limit that does not exist.
    expect(scopeView(rule({ scope: { tools: [], agents: [] } })).kind).toBe(
      'unscoped',
    );
  });

  it('marks a condition as advanced only when it leaves the exact whole-value form', () => {
    expect(
      isAdvancedCondition({ target: 'command', kind: 'exact', pattern: 'x' }),
    ).toBe(false);
    expect(
      isAdvancedCondition({ target: 'command', kind: 'regex', pattern: 'x' }),
    ).toBe(true);
    expect(
      isAdvancedCondition({ target: 'command', kind: 'glob', pattern: 'x' }),
    ).toBe(true);
    expect(
      isAdvancedCondition({
        target: 'command',
        kind: 'exact',
        pattern: 'x',
        caseSensitive: false,
      }),
    ).toBe(true);
    // A selector and a multi-value mode both make the condition read a field.
    expect(
      isAdvancedCondition({
        target: 'argument',
        path: '$.a',
        kind: 'exact',
        pattern: 'x',
      }),
    ).toBe(true);
    expect(
      isAdvancedCondition({
        target: 'argument',
        path: '$.a',
        kind: 'exact',
        pattern: 'x',
        multi: 'all',
      }),
    ).toBe(true);
  });
});
