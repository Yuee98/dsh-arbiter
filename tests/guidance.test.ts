import { describe, expect, test } from 'vitest';

import {
  COMMON_GUIDANCE,
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
  test('every managed agent is told a rejected call was not executed', () => {
    for (const text of BOTH) {
      expect(text).toMatch(/rejected tool call was not executed/iu);
    }
  });

  test('every managed agent is told to try a permitted alternative first', () => {
    for (const text of BOTH) {
      expect(text).toMatch(/allowed alternative/iu);
    }
  });

  test('every managed agent is told not to repeat an unchanged blocked effect', () => {
    for (const text of BOTH) {
      expect(text).toMatch(/do not repeat a blocked effect/iu);
    }
  });

  test.each(BOTH)(
    'a permitted alternative is stated before any escalation: %s',
    (text) => {
      const alternative = text.search(/allowed alternative/iu);
      const escalate = Math.min(
        ...[/report/iu, /ask surface/iu]
          .map((pattern) => text.search(pattern))
          .filter((index) => index >= 0),
      );
      expect(alternative).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(escalate)).toBe(true);
      expect(alternative).toBeLessThan(escalate);
    },
  );

  test('a subagent reports the pending operation, reason and needed help', () => {
    expect(SUBAGENT_GUIDANCE).toMatch(/report the pending operation/iu);
    expect(SUBAGENT_GUIDANCE).toMatch(/blocking reason/iu);
    expect(SUBAGENT_GUIDANCE).toMatch(/help you need/iu);
    // The reporting duty belongs to the subagent, not to the parent text.
    expect(PARENT_GUIDANCE).not.toMatch(/report the pending operation/iu);
  });

  test('a parent relays with the original words and scope unchanged', () => {
    expect(PARENT_GUIDANCE).toMatch(/relay the answer/iu);
    expect(PARENT_GUIDANCE).toMatch(/original words and scope unchanged/iu);
  });

  test('a main agent whose own call is blocked asks the user, not the subtask', () => {
    // A main session also runs its own tool calls, so its guidance must name
    // the remaining path for those: ask the user for the clarification or the
    // scoped authorization needed.
    expect(PARENT_GUIDANCE).toMatch(/When your own call is blocked/iu);
    expect(PARENT_GUIDANCE).toMatch(
      /ask the user for the missing clarification or scope/iu,
    );
    // That path belongs to the main text; the subagent reports to its parent.
    expect(SUBAGENT_GUIDANCE).not.toMatch(/When your own call is blocked/iu);
  });

  test('a parent never asks on the subagent behalf and states the exact scope', () => {
    expect(PARENT_GUIDANCE).toMatch(/state the exact operation and scope/iu);
    expect(PARENT_GUIDANCE).toMatch(
      /approval modes do not restrict these questions/iu,
    );
  });

  test('the common paragraph is shared verbatim by both roles', () => {
    expect(COMMON_GUIDANCE.length).toBeGreaterThan(0);
    for (const text of BOTH) expect(text).toContain(COMMON_GUIDANCE);
  });

  test.each(BOTH)('the text is short and single-paragraph: %s', (text) => {
    // Two paragraphs' worth of instruction at most: the common contract plus
    // one role duty, never a handbook.
    expect(text.length).toBeLessThan(820);
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
      // may name the order alternative-then-help but no numbered procedure.
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
    expect(guidanceText('subagent')).toContain(COMMON_GUIDANCE);
  });

  test('a main session gets the parent guidance', () => {
    expect(guidanceText('main')).toBe(PARENT_GUIDANCE);
    // A main session also runs its own tool calls, so it keeps the common
    // non-execution and alternative-first semantics rather than only the
    // subtask-handling paragraph.
    expect(guidanceText('main')).toContain(COMMON_GUIDANCE);
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
