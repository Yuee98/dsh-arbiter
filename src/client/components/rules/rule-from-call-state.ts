/**
 * Panel state for the two ways a rule draft gets a recorded call.
 *
 * Both entries converge on one pending source: the dialog always builds from a
 * call the user picked, never from a call the page decided to reuse. A created
 * rule keeps its seed, so asking to test that rule again starts from the recorded
 * call instead of from whatever sample the tester happens to hold — that is what
 * makes one recorded call usable as both the positive and the negative test.
 *
 * A focus request is not an execution: it selects the tester target and supplies
 * the inputs, exactly as the header action does. Nothing here runs a test.
 */

import { useMemo, useReducer } from 'react';
import type { RuleCallSource } from './rule-from-call-model.js';
import type { ImportedTestSample } from './rule-test-source.js';
import type { SampleSeed } from './rule-test.js';

/** What a created rule keeps for its own recorded call, before it is numbered. */
export interface CreatedSample {
  readonly callId: string;
  readonly imported: ImportedTestSample;
}

export interface RulesPanelCallState {
  /** The call awaiting the draft dialog, or null when it is closed. */
  readonly source: RuleCallSource | null;
  /** One stored seed per rule built from a call. */
  readonly seeds: Readonly<Record<string, SampleSeed>>;
  readonly focusedId: string | null;
  /** Bumped per request, so re-targeting the tester is always a new request. */
  readonly focusRequest: number;
  /** The seed the tester should apply now, if any. */
  readonly activeSeed: SampleSeed | null;
}

export type RulesPanelCallAction =
  | { readonly kind: 'source'; readonly source: RuleCallSource }
  | { readonly kind: 'cancel-source' }
  | {
      readonly kind: 'created';
      readonly ruleId: string;
      readonly sample: CreatedSample;
      /** Whether the create action also asked to test the draft immediately. */
      readonly test: boolean;
    }
  | { readonly kind: 'prune'; readonly ruleIds: readonly string[] }
  | { readonly kind: 'focus-rule'; readonly ruleId: string }
  | { readonly kind: 'focus-none' }
  | { readonly kind: 'clear-focus' };

export const INITIAL_RULES_PANEL_CALL: RulesPanelCallState = {
  source: null,
  seeds: {},
  focusedId: null,
  focusRequest: 0,
  activeSeed: null,
};

export function rulesPanelCallReducer(
  state: RulesPanelCallState,
  action: RulesPanelCallAction,
): RulesPanelCallState {
  switch (action.kind) {
    case 'source':
      return { ...state, source: action.source };
    case 'cancel-source':
      return { ...state, source: null };
    case 'created': {
      const nonce = state.focusRequest + 1;
      const seed: SampleSeed = { ...action.sample, nonce };
      // The seed is stored either way: the rule's own recorded call is what a
      // later "test this rule" must start from, whether or not this action also
      // opened the tester now. A create without a test request therefore leaves
      // the tester closed and claims nothing about having tested the rule.
      return {
        ...state,
        source: null,
        seeds: { ...state.seeds, [action.ruleId]: seed },
        ...(action.test
          ? {
              focusedId: action.ruleId,
              focusRequest: nonce,
              activeSeed: seed,
            }
          : { activeSeed: null }),
      };
    }
    case 'prune': {
      // A deleted rule's id can be handed out again by the next create, so its
      // stored call must not survive it: a fresh rule would otherwise be tested
      // against a recorded call it was never built from.
      const kept = Object.entries(state.seeds).filter(([ruleId]) =>
        action.ruleIds.includes(ruleId),
      );
      if (kept.length === Object.keys(state.seeds).length) return state;
      return { ...state, seeds: Object.fromEntries(kept) };
    }
    case 'focus-rule': {
      const nonce = state.focusRequest + 1;
      const stored = state.seeds[action.ruleId];
      return {
        ...state,
        focusedId: action.ruleId,
        focusRequest: nonce,
        activeSeed: stored === undefined ? null : { ...stored, nonce },
      };
    }
    case 'focus-none':
      return {
        ...state,
        focusedId: null,
        focusRequest: state.focusRequest + 1,
        activeSeed: null,
      };
    case 'clear-focus':
      return { ...state, focusedId: null };
  }
}

/** The reducer bound to one panel, with the actions the panel dispatches. */
export function useRulesPanelCall(): {
  readonly state: RulesPanelCallState;
  readonly pickSource: (source: RuleCallSource) => void;
  readonly cancelSource: () => void;
  readonly created: (
    ruleId: string,
    sample: CreatedSample,
    test: boolean,
  ) => void;
  readonly pruneSeeds: (ruleIds: readonly string[]) => void;
  readonly focusRule: (ruleId: string) => void;
  readonly focusNone: () => void;
  readonly clearFocus: () => void;
} {
  const [state, dispatch] = useReducer(
    rulesPanelCallReducer,
    INITIAL_RULES_PANEL_CALL,
  );
  return useMemo(
    () => ({
      state,
      pickSource: (source: RuleCallSource) => {
        dispatch({ kind: 'source', source });
      },
      cancelSource: () => {
        dispatch({ kind: 'cancel-source' });
      },
      created: (ruleId: string, sample: CreatedSample, test: boolean) => {
        dispatch({ kind: 'created', ruleId, sample, test });
      },
      pruneSeeds: (ruleIds: readonly string[]) => {
        dispatch({ kind: 'prune', ruleIds });
      },
      focusRule: (ruleId: string) => {
        dispatch({ kind: 'focus-rule', ruleId });
      },
      focusNone: () => {
        dispatch({ kind: 'focus-none' });
      },
      clearFocus: () => {
        dispatch({ kind: 'clear-focus' });
      },
    }),
    [state],
  );
}
