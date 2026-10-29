/**
 * Drafting a rule from one recorded call.
 *
 * The last group runs the real evaluator: a draft built from a call must actually
 * decide that call, and a neighboring call that differs in a pinned value must not
 * match. Hand-written fixtures would only prove that the builder emits the shape
 * the test expected, not that the shape means anything to the gate.
 */

import { describe, expect, it } from 'vitest';

import {
  callSourceOfDetail,
  callFields,
  draftRuleFromCall,
  importedSampleOf,
  initialSelection,
  ruleCallSource,
  unconstrainedFields,
} from '../src/client/components/rules/rule-from-call-model.js';
import { evaluateCall } from '../src/rules/match.js';
import type { CommandRule, SessionKind } from '../src/types.js';
import type { CallDetailView } from '../src/client/view-types.js';

const DEPLOY_ARGS = {
  environments: ['test'],
  target: { path: '/srv/app', force: false },
  dryRun: true,
  retries: 2,
  note: null,
};

function source(
  tool = 'deploy',
  args: unknown = DEPLOY_ARGS,
  options: {
    readonly identity?: SessionKind;
    readonly cwd?: string | null;
  } = {},
) {
  return ruleCallSource('call-1', tool, args, {
    identity: options.identity ?? 'main',
    cwd: options.cwd ?? '/srv/app',
  });
}

function fieldIds(fields: ReturnType<typeof callFields>): readonly string[] {
  return fields.fields.map((field) => field.id);
}

describe('the pinnable values of a recorded call', () => {
  it('offers the tool name and one exact condition per scalar argument', () => {
    expect(fieldIds(callFields(source()))).toEqual([
      'tool',
      '$.target.path',
      '$.target.force',
      '$.dryRun',
      '$.retries',
      '$.note',
    ]);
  });

  it('keeps the recorded JSON type of every pinned value', () => {
    const fields = callFields(source()).fields;
    const byId = new Map(fields.map((field) => [field.id, field]));
    expect(byId.get('$.target.force')?.pattern).toBe(false);
    expect(byId.get('$.retries')?.pattern).toBe(2);
    // `null` is a value that has to be present, not an absent field.
    expect(byId.get('$.note')?.pattern).toBeNull();
    expect(byId.get('tool')?.pattern).toBe('deploy');
    // The tool condition is a whole-value match and carries no selector.
    expect(byId.get('tool')?.path).toBeNull();
    expect(byId.get('$.target.path')?.path).toBe('$.target.path');
  });

  it('reports arrays and empty objects instead of flattening them', () => {
    const fields = callFields(
      source('deploy', { environments: ['test', 'prod'], extra: {} }),
    );
    expect(fieldIds(fields)).toEqual(['tool']);
    expect(fields.unpinnable.map((entry) => [entry.id, entry.reason])).toEqual([
      ['$.environments', 'array'],
      ['$.extra', 'empty-object'],
    ]);
  });

  it('brackets keys that dot notation would read as a nested member', () => {
    const fields = callFields(source('deploy', { 'a.b': 1, 'odd key': 'x' }));
    expect(fieldIds(fields)).toEqual(['tool', '$["a.b"]', '$["odd key"]']);
  });

  it('bounds a deeply nested argument object instead of walking it forever', () => {
    // Four levels below the root is where the walk stops; the member at that
    // depth is named rather than silently skipped, so the dialog can say the
    // rule does not constrain it.
    const fields = callFields(
      source('deploy', { a: { b: { c: { d: { e: 1 } } } } }),
    );
    expect(fieldIds(fields)).toEqual(['tool']);
    expect(fields.unpinnable).toEqual([
      { id: '$.a.b.c.d', label: '$.a.b.c.d', reason: 'too-deep' },
    ]);
  });

  it('caps the field count and names the surplus', () => {
    const args: Record<string, number> = {};
    for (let index = 0; index < 60; index += 1)
      args[`key${String(index)}`] = index;
    const fields = callFields(source('deploy', args));
    expect(fields.fields).toHaveLength(40);
    expect(fields.unpinnable).toHaveLength(21);
    expect(fields.unpinnable[0]?.reason).toBe('too-many');
  });

  it('offers only the tool name when the call carries no arguments', () => {
    expect(fieldIds(callFields(source('bash', null)))).toEqual(['tool']);
  });
});

describe('the rule a selection becomes', () => {
  const fields = callFields(source()).fields;

  it('starts from every pinnable field', () => {
    expect(initialSelection(fields)).toEqual(
      fieldIds({ fields, unpinnable: [] }),
    );
  });

  it('covers exactly what a narrower selection asks for', () => {
    const rule = draftRuleFromCall({
      rules: [],
      fields,
      selected: ['$.dryRun'],
      verdict: 'force-ask',
      comment: 'call-1',
    });
    expect(rule).toEqual({
      id: 'rule-1',
      conditions: [
        { target: 'argument', path: '$.dryRun', kind: 'exact', pattern: true },
      ],
      verdict: 'force-ask',
      enabled: true,
      comment: 'call-1',
    });
    // One condition has nothing to combine, so the connective is omitted rather
    // than recording a choice the rule does not make.
    expect(rule).not.toHaveProperty('combine');
  });

  it('conjoins several pinned fields so a second one narrows the rule', () => {
    const rule = draftRuleFromCall({
      rules: [],
      fields,
      selected: ['tool', '$.dryRun'],
      verdict: 'allow',
      comment: 'call-1',
    });
    expect(rule?.combine).toBe('all');
    expect(rule?.conditions).toEqual([
      { target: 'tool', kind: 'exact', pattern: 'deploy' },
      { target: 'argument', path: '$.dryRun', kind: 'exact', pattern: true },
    ]);
  });

  it('builds nothing when the selection is empty', () => {
    expect(
      draftRuleFromCall({
        rules: [],
        fields,
        selected: [],
        verdict: 'force-review',
        comment: 'call-1',
      }),
    ).toBeNull();
  });

  it('takes the next free id from the draft it joins', () => {
    const rule = draftRuleFromCall({
      rules: [
        {
          id: 'rule-1',
          conditions: [],
          verdict: 'deny',
        },
      ],
      fields,
      selected: ['tool'],
      verdict: 'deny',
      comment: 'call-1',
    });
    expect(rule?.id).toBe('rule-2');
  });

  it('names every recorded value the rule leaves open', () => {
    const fieldSet = callFields(
      source('deploy', { environments: ['test'], dryRun: true }),
    );
    expect(
      unconstrainedFields(fieldSet, ['tool']).map((entry) => [
        entry.id,
        entry.kind,
      ]),
    ).toEqual([
      ['$.dryRun', 'deselected'],
      ['$.environments', 'array'],
    ]);
  });
});

/**
 * The evaluator is the contract, so a draft is checked against it.
 *
 * `testRules` is the same entry the tester route calls, and `evaluateCall` is the
 * gate's; both are used here so the draft is proven against the shared matcher
 * rather than against an expected object.
 */
function pathOf(
  rules: readonly CommandRule[],
  tool: string,
  args: unknown,
): string {
  const evaluation = evaluateCall({
    rules,
    tool,
    arguments: args,
    identity: 'main',
    workspaceRoot: '/srv/app',
    cwd: '/srv/app',
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });
  return evaluation.path.kind === 'rule'
    ? evaluation.path.verdict
    : `review(default):${evaluation.path.reason}`;
}

describe('a draft built from a call decides that call', () => {
  const fields = callFields(source()).fields;
  const full = draftRuleFromCall({
    rules: [],
    fields,
    selected: initialSelection(fields),
    verdict: 'force-review',
    comment: 'call-1',
  });

  it('matches the recorded call', () => {
    expect(full).not.toBeNull();
    if (full === null) return;
    expect(pathOf([full], 'deploy', DEPLOY_ARGS)).toBe('force-review');
  });

  it('does not match a call that differs in one pinned value', () => {
    if (full === null) throw new Error('expected a draft');
    expect(pathOf([full], 'deploy', { ...DEPLOY_ARGS, dryRun: false })).toBe(
      'review(default):no-match',
    );
    expect(pathOf([full], 'deploy', { ...DEPLOY_ARGS, retries: 3 })).toBe(
      'review(default):no-match',
    );
    expect(pathOf([full], 'deploy', { ...DEPLOY_ARGS, note: undefined })).toBe(
      'review(default):no-match',
    );
  });

  it('does not match a different tool', () => {
    if (full === null) throw new Error('expected a draft');
    expect(pathOf([full], 'publish', DEPLOY_ARGS)).toBe(
      'review(default):no-match',
    );
  });

  it('still matches when only the pinned field of a narrower draft agrees', () => {
    const narrower = draftRuleFromCall({
      rules: [],
      fields,
      selected: ['$.dryRun'],
      verdict: 'force-review',
      comment: 'call-1',
    });
    if (narrower === null) throw new Error('expected a draft');
    // The opposite of the full draft's behaviour, which is what makes the
    // selection observable rather than decorative.
    expect(pathOf([narrower], 'deploy', { ...DEPLOY_ARGS, retries: 9 })).toBe(
      'force-review',
    );
  });

  it('does not reproduce an array value it could not pin', () => {
    const arraySource = ruleCallSource(
      'call-2',
      'deploy',
      { environments: ['prod'], dryRun: true },
      { identity: 'main', cwd: null },
    );
    const arrayFields = callFields(arraySource);
    const rule = draftRuleFromCall({
      rules: [],
      fields: arrayFields.fields,
      selected: initialSelection(arrayFields.fields),
      verdict: 'force-review',
      comment: 'call-2',
    });
    if (rule === null) throw new Error('expected a draft');
    // The array is unconstrained, so a different environment still matches: the
    // panel must say so instead of implying the rule reproduces the call.
    expect(
      pathOf([rule], 'deploy', { environments: ['test'], dryRun: true }),
    ).toBe('force-review');
    expect(arrayFields.unpinnable.map((entry) => entry.id)).toEqual([
      '$.environments',
    ]);
  });
});

/**
 * Every offered field must actually match through the evaluator.
 *
 * A field the dialog offers but the engine cannot address would let a rule
 * describe the call and then fail to match it — for a deny rule that means the
 * restriction the user wrote never applies. These cases are built with
 * `JSON.parse` so the source object is exactly what a recorded call stores.
 */
describe('every offered field matches through the evaluator', () => {
  const KEY_CASES: readonly (readonly [string, string])[] = [
    ['an ordinary name', 'dryRun'],
    ['a dotted name', 'a.b'],
    ['a spaced name', 'odd key'],
    ['a leading digit', '0'],
    ['a leading dollar', '$dollar'],
    ['the prototype member name', '__proto__'],
    ['an inherited member name', 'constructor'],
    ['a nested member name', 'nested.value'],
  ];

  it.each(KEY_CASES)(
    'pins %s as a rule that matches the call',
    (_label, key) => {
      const args: unknown = JSON.parse(
        key === 'nested.value'
          ? '{"nested":{"value":"pinned"},"dryRun":true}'
          : JSON.stringify({ [key]: 'pinned', dryRun: true }),
      );
      const recorded = ruleCallSource('call-key', 'deploy', args, {
        identity: 'main',
        cwd: null,
      });
      const fieldSet = callFields(recorded);
      const rule = draftRuleFromCall({
        rules: [],
        fields: fieldSet.fields,
        selected: initialSelection(fieldSet.fields),
        verdict: 'force-review',
        comment: 'call-key',
      });
      if (rule === null) throw new Error('expected a draft');
      expect(pathOf([rule], 'deploy', args)).toBe('force-review');
    },
  );
});

describe('a call whose arguments are not an object', () => {
  it('names the whole value as unconstrained instead of dropping it', () => {
    const arraySource = ruleCallSource(
      'call-array',
      'example',
      JSON.parse('["one","two"]'),
      { identity: 'main', cwd: null },
    );
    const fieldSet = callFields(arraySource);
    expect(fieldIds(fieldSet)).toEqual(['tool']);
    expect(fieldSet.unpinnable).toEqual([
      { id: '$', label: '$', reason: 'non-object-arguments' },
    ]);
    expect(
      unconstrainedFields(fieldSet, initialSelection(fieldSet.fields)),
    ).toEqual([{ id: '$', label: '$', kind: 'non-object-arguments' }]);
  });

  it('still produces a rule that the evaluator matches', () => {
    const args: unknown = JSON.parse('["one","two"]');
    const arraySource = ruleCallSource('call-array', 'example', args, {
      identity: 'main',
      cwd: null,
    });
    const fieldSet = callFields(arraySource);
    const rule = draftRuleFromCall({
      rules: [],
      fields: fieldSet.fields,
      selected: initialSelection(fieldSet.fields),
      verdict: 'force-review',
      comment: 'call-array',
    });
    if (rule === null) throw new Error('expected a draft');
    expect(pathOf([rule], 'example', args)).toBe('force-review');
  });
});

describe('the recorded directory is part of the evaluation input', () => {
  // A directory name may end in whitespace, and a relative target resolves
  // against it, so trimming the recorded cwd is not cosmetic: these two paths
  // are different, and a rule may cover exactly one of them.
  const REDIRECT_DENY: readonly CommandRule[] = [
    {
      id: 'deny-secret',
      verdict: 'deny',
      conditions: [
        {
          target: 'file_redirect',
          kind: 'exact',
          pattern: '/srv/app /secret.txt',
        },
      ],
    },
  ];

  function redirectPath(cwd: string): string {
    const evaluation = evaluateCall({
      rules: REDIRECT_DENY,
      tool: 'bash',
      arguments: { command: 'echo x > secret.txt' },
      identity: 'main',
      workspaceRoot: cwd,
      cwd,
      parentAuthorizationPresent: null,
      historyTruncated: false,
      overlapsDeniedEffect: false,
    });
    return evaluation.path.kind === 'rule'
      ? evaluation.path.verdict
      : `review(default):${evaluation.path.reason}`;
  }

  it('resolves to different paths with and without the trailing space', () => {
    expect(redirectPath('/srv/app ')).toBe('deny');
    expect(redirectPath('/srv/app')).toBe('review(default):no-match');
  });
});

describe('the recorded sample a draft carries for the tester', () => {
  it('replays the call as its recorded argument object and context', () => {
    const recorded = source('deploy', DEPLOY_ARGS, {
      identity: 'subagent',
      cwd: '/srv/app',
    });
    const imported = importedSampleOf(recorded);
    expect(imported.sample.tool).toBe('deploy');
    expect(imported.sample.args).toEqual(DEPLOY_ARGS);
    expect(imported.sample.input).toBe(JSON.stringify(DEPLOY_ARGS, null, 2));
    expect(imported.identity).toBe('subagent');
    expect(imported.cwd).toBe('/srv/app');
  });
});

/** The parts of a decoded detail this test varies. */
function detail(patch: Partial<CallDetailView> = {}): CallDetailView {
  const base: CallDetailView = {
    callId: 'call-9',
    source: 'audit',
    recordFormatVersion: 2,
    unreadable: false,
    unreadableReason: null,
    overview: {
      tool: 'deploy',
      ts: 1,
      sessionId: 'session-1',
      sessionKind: 'subagent',
      parentSession: null,
      workspace: '/srv/app',
      cwd: '/srv/app',
      profile: 'default',
      approvalMode: 'ask',
      executionMode: 'guarded',
      verdict: 'allow',
      verdictReason: 'allowed',
      configRevision: 'rev-1',
      fingerprint: 'deploy:1',
      execution: { status: 'succeeded', startedAt: 1, finishedAt: 2 },
      cancelled: false,
    },
    basis: {
      rule: null,
      decisionRules: [],
      conflicts: [],
      conflictsTruncated: false,
      policyStrategy: null,
      chain: null,
      reviewState: 'none',
      trace: [],
      signals: null,
      evidence: [],
      materials: [],
      evidenceTruncated: false,
      snapshotMissing: [],
      historyStatus: null,
      effect: null,
    },
    raw: {
      arguments: { dryRun: true },
      argumentsSchema: null,
      snapshot: null,
      config: null,
      configFormatVersion: null,
      snapshotFormatVersion: null,
      modelAttempts: [],
      templates: [],
      sessionRecordState: 'written',
    },
    missing: [],
    missingUnknown: 0,
  };
  return { ...base, ...patch };
}

describe('a decoded call detail as a draft source', () => {
  it('uses the stored arguments and the recorded context', () => {
    const recorded = callSourceOfDetail(detail());
    expect(recorded).not.toBeNull();
    expect(recorded?.callId).toBe('call-9');
    expect(recorded?.tool).toBe('deploy');
    expect(recorded?.identity).toBe('subagent');
    expect(recorded?.cwd).toBe('/srv/app');
    expect(recorded?.sample.args).toEqual({ dryRun: true });
  });

  it('offers nothing for a record without stored input', () => {
    const absent = detail();
    expect(
      callSourceOfDetail({
        ...absent,
        raw: { ...absent.raw, arguments: null },
      }),
    ).toBeNull();
  });

  it('does not treat an ambiguous stored null as a recorded null argument', () => {
    // The decoded detail cannot say whether `null` is a recorded JSON null or a
    // field the record never wrote. Offering a draft would claim the call's input
    // is known when it may be missing, so the entry stays withheld; the tester's
    // own route does evaluate an explicit null correctly once one is known.
    const absent = detail();
    expect(
      callSourceOfDetail({
        ...absent,
        raw: { ...absent.raw, arguments: null },
      }),
    ).toBeNull();
  });

  it('offers nothing for an unreadable record', () => {
    expect(
      callSourceOfDetail(detail({ unreadable: true, unreadableReason: 'v9' })),
    ).toBeNull();
  });
});
