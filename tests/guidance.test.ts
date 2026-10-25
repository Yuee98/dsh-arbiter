import { describe, expect, test } from 'vitest';

import {
  GUIDANCE_SECTION,
  PARENT_GUIDANCE,
  SUBAGENT_GUIDANCE,
  guidanceText,
  selectGuidance,
} from '../src/host/guidance.js';

/**
 * The standing guidance is a stable contract, so these assertions are about
 * what the text must and must not say rather than about its exact wording.
 *
 * The three properties the issue requires: it states that a rejected call was
 * not executed, it puts a permitted alternative before asking for help, and it
 * never hard-codes a current mode, a current failure, or a fixed recovery
 * script. A future wording change has to keep those properties, not this
 * string.
 */

const BOTH = [SUBAGENT_GUIDANCE, PARENT_GUIDANCE];

/** Escape one literal phrase for use inside a regular expression. */
function escape(phrase: string): string {
  return phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/** Phrases that would turn stable guidance into per-call or per-mode state. */
const STATE_SPECIFIC = [
  'normal',
  'strict',
  'progress',
  'fallback-deny',
  'human-deny',
  'review-deny',
  'deny-rule',
  'workspace-write',
  'danger-full-access',
  'trusted',
  'guarded',
  'Not executed [',
  'rule "',
];

describe('standing guidance text', () => {
  test('a rejected call is stated as not executed', () => {
    expect(SUBAGENT_GUIDANCE).toMatch(/not executed/iu);
  });

  test('a permitted alternative comes before reporting to the parent', () => {
    const alternative = SUBAGENT_GUIDANCE.search(/alternative/iu);
    const report = SUBAGENT_GUIDANCE.search(/report/iu);
    expect(alternative).toBeGreaterThanOrEqual(0);
    expect(report).toBeGreaterThan(alternative);
  });

  test('the parent relays the answer without widening its scope', () => {
    expect(PARENT_GUIDANCE).toMatch(/relay/iu);
    expect(PARENT_GUIDANCE).toMatch(/scope/iu);
    expect(PARENT_GUIDANCE).toMatch(/ask/iu);
  });

  test('asking is never restricted by the approval mode', () => {
    expect(PARENT_GUIDANCE).toMatch(
      /approval modes do not restrict these questions/iu,
    );
  });

  test.each(BOTH)('the text is short and single-paragraph: %s', (text) => {
    expect(text.length).toBeLessThan(600);
    expect(text).not.toContain('\n');
  });

  test.each(BOTH)(
    'no current mode, failure or evidence is baked in: %s',
    (text) => {
      for (const phrase of STATE_SPECIFIC) {
        // Whole words only: "restrict" is not the "strict" mode.
        const pattern = new RegExp(
          `(?:^|[^a-z0-9-])${escape(phrase)}(?:$|[^a-z0-9-])`,
          'iu',
        );
        expect(text).not.toMatch(pattern);
      }
    },
  );

  test.each(BOTH)(
    'recovery stays advice, not a mandatory script: %s',
    (text) => {
      // Steps and ordering words are what turn guidance into a script; the text
      // may name the order alternative-then-report but no numbered procedure.
      expect(text).not.toMatch(
        /(?:^|\s)(?:1\.|2\.|step\s*\d|first,|second,)/iu,
      );
      // A permission verdict is not the guidance's to promise.
      expect(text).not.toMatch(/will be approved/iu);
    },
  );
});

describe('role selection', () => {
  test('a subagent gets the reporting guidance', () => {
    expect(guidanceText('subagent')).toBe(SUBAGENT_GUIDANCE);
  });

  test('a main session gets the parent guidance', () => {
    expect(guidanceText('main')).toBe(PARENT_GUIDANCE);
  });
});

describe('managed-scope selection', () => {
  test('an admitted session receives its role guidance', () => {
    expect(selectGuidance({ active: true, managed: true, kind: 'main' })).toBe(
      PARENT_GUIDANCE,
    );
    expect(
      selectGuidance({ active: true, managed: true, kind: 'subagent' }),
    ).toBe(SUBAGENT_GUIDANCE);
  });

  test('a session the plugin has not taken over receives nothing', () => {
    expect(selectGuidance({ active: true, managed: false, kind: 'main' })).toBe(
      '',
    );
    expect(
      selectGuidance({ active: true, managed: false, kind: 'subagent' }),
    ).toBe('');
  });

  test('a disabled or unloading plugin contributes nothing', () => {
    expect(selectGuidance({ active: false, managed: true, kind: 'main' })).toBe(
      '',
    );
    expect(
      selectGuidance({ active: false, managed: true, kind: 'subagent' }),
    ).toBe('');
  });
});

test('the contribution name is namespaced to this plugin', () => {
  expect(GUIDANCE_SECTION).toMatch(/^arbiter:/u);
  expect(GUIDANCE_SECTION).not.toBe('approval:policy');
});
