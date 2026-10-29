/**
 * Turning one recorded call into an editable rule draft.
 *
 * Everything here works on the call's recorded facts: the tool name and the
 * argument object are the values the gate actually judged, and nothing is
 * re-derived by re-running the call. The module answers three questions and
 * nothing else — which recorded values can be pinned to one exact match, which
 * of them the user selected, and what rule those selections become.
 *
 * It never derives a verdict from the call's own outcome. A call that was
 * approved once is not a permanent authorization, so the behavior is always the
 * user's explicit choice and the draft starts from the safe direction.
 */

import type { RulePattern, RuleVerdict, SessionKind } from '../../../types.js';
import type { CallDetailView, DraftRule } from '../../view-types.js';
import { nextRuleId } from './draft.js';
import type { TestSample } from './rule-test-model.js';
import type { ImportedTestSample } from './rule-test-source.js';

/**
 * A recorded call, kept next to the sample the tester replays.
 *
 * `callId` is not part of the evaluation input. It is kept so the draft can name
 * the call it came from, and so the positive and the negative test are traceable
 * to the same recorded call.
 */
export interface RuleCallSource {
  readonly callId: string;
  readonly tool: string;
  readonly sample: TestSample;
  readonly identity: SessionKind;
  readonly cwd: string | null;
}

/** Why one recorded value cannot become an exact condition. */
export type CallFieldReason =
  'array' | 'empty-object' | 'too-deep' | 'too-many';

/** One recorded value that can be pinned to a single exact match. */
export interface CallField {
  /** Stable id: the JSONPath of the argument, or `tool` for the tool name. */
  readonly id: string;
  /** `argument` conditions carry `path`; the tool name has none to carry. */
  readonly path: string | null;
  readonly pattern: RulePattern;
  /**
   * The protocol name this value is compared on: `tool` or the JSONPath.
   *
   * It is the condition's own address, never a translation of it, so a reader
   * can copy it and a test can pin it without depending on the host language.
   */
  readonly label: string;
  /** The recorded value in its JSON spelling, kept exactly as it was stored. */
  readonly valueText: string;
}

/** One recorded value that stays visible but cannot be pinned. */
export interface UnpinnableField {
  readonly id: string;
  readonly label: string;
  readonly reason: CallFieldReason;
}

export interface CallFieldSet {
  readonly fields: readonly CallField[];
  readonly unpinnable: readonly UnpinnableField[];
}

/**
 * What the rule does not pin down.
 *
 * Both halves matter to the reader: a value they chose not to fix, and a value
 * the call contains that no exact condition can express. Neither is silently
 * dropped, because "the rule reproduces this call" is only true when nothing is
 * left unconstrained.
 */
export interface UnconstrainedField {
  readonly id: string;
  readonly label: string;
  readonly kind: 'deselected' | CallFieldReason;
}

/**
 * Bounds for a hostile argument object.
 *
 * A model-authored call may carry a large or deeply nested argument object. The
 * dialog stays useful by listing a bounded number of fields and reporting the
 * rest as unpinnable instead of silently dropping them.
 */
const MAX_FIELDS = 40;
const MAX_DEPTH = 4;

const SIMPLE_KEY = /^[A-Za-z_$][A-Za-z0-9_$]*$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Whether a recorded value is an exact-comparable JSON scalar.
 *
 * The pattern keeps its JSON type, so `false` never becomes the string
 * `"false"`, and `null` stays a value that has to actually be present.
 */
function isRulePattern(value: unknown): value is RulePattern {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}

/**
 * The JSONPath that selects exactly one member.
 *
 * A key that is not an identifier cannot be spelled with dot notation: `$.a.b`
 * would select a nested member, not the member actually named `a.b`, and a rule
 * built from that path would never match the call it came from.
 */
function member(path: string, key: string): string {
  return SIMPLE_KEY.test(key)
    ? `${path}.${key}`
    : `${path}[${JSON.stringify(key)}]`;
}

/**
 * The replayable sample of one recorded call.
 *
 * The tester takes the same shape as its own import, so a draft created from a
 * call and a call picked inside the tester feed the evaluator identically.
 */
export function importedSampleOf(source: RuleCallSource): ImportedTestSample {
  return {
    sample: source.sample,
    identity: source.identity,
    cwd: source.cwd,
  };
}

/** The recorded call as the dialog needs it, from facts it already holds. */
export function ruleCallSource(
  callId: string,
  tool: string,
  args: unknown,
  options: {
    readonly identity: SessionKind;
    readonly cwd: string | null;
  },
): RuleCallSource {
  return {
    callId,
    tool,
    sample: { tool, args, input: JSON.stringify(args, null, 2) },
    identity: options.identity,
    cwd: options.cwd,
  };
}

/**
 * The call a decoded detail can seed a draft from.
 *
 * The raw argument object is the one the gate judged, so it is read as stored.
 * A detail without it (a record that never wrote its input, an unreadable
 * record) offers no entry: a draft built from an invented empty object would
 * describe a call nobody made.
 */
export function callSourceOfDetail(
  detail: CallDetailView,
): RuleCallSource | null {
  if (detail.unreadable || detail.overview.tool.length === 0) return null;
  const args = detail.raw.arguments;
  if (args === undefined || args === null) return null;
  return ruleCallSource(detail.callId, detail.overview.tool, args, {
    identity: detail.overview.sessionKind === 'subagent' ? 'subagent' : 'main',
    cwd: detail.overview.cwd,
  });
}

/**
 * The fields this call can pin.
 *
 * The tool name is always a field: it is the one fact every call carries, and it
 * is the narrowest thing a rule can say about that call. Arguments contribute one
 * field per scalar leaf, addressed by the JSONPath that selects exactly that
 * value. Arrays and empty objects are reported as unpinnable rather than being
 * flattened into a value the user never saw.
 */
export function callFields(source: RuleCallSource): CallFieldSet {
  const fields: CallField[] = [
    {
      id: 'tool',
      path: null,
      // The condition's own address, never a translated field name: a reader can
      // copy it and a test can pin it without depending on the host language.
      label: 'tool',
      pattern: source.tool,
      valueText: JSON.stringify(source.tool),
    },
  ];
  const unpinnable: UnpinnableField[] = [];

  const add = (path: string, value: RulePattern): void => {
    if (fields.length >= MAX_FIELDS) {
      unpinnable.push({ id: path, label: path, reason: 'too-many' });
      return;
    }
    fields.push({
      id: path,
      path,
      label: path,
      pattern: value,
      valueText: JSON.stringify(value),
    });
  };

  const walk = (
    value: Record<string, unknown>,
    path: string,
    depth: number,
  ): void => {
    for (const [key, entry] of Object.entries(value)) {
      const child = member(path, key);
      if (isRecord(entry)) {
        if (Object.keys(entry).length === 0) {
          unpinnable.push({ id: child, label: child, reason: 'empty-object' });
        } else if (depth + 1 >= MAX_DEPTH) {
          unpinnable.push({ id: child, label: child, reason: 'too-deep' });
        } else {
          walk(entry, child, depth + 1);
        }
        continue;
      }
      if (Array.isArray(entry)) {
        unpinnable.push({ id: child, label: child, reason: 'array' });
        continue;
      }
      if (!isRulePattern(entry)) {
        unpinnable.push({ id: child, label: child, reason: 'too-deep' });
        continue;
      }
      add(child, entry);
    }
  };

  if (isRecord(source.sample.args)) walk(source.sample.args, '$', 0);
  return { fields, unpinnable };
}

/**
 * The selection a new draft starts from: every pinnable value.
 *
 * Pinning everything reproduces the recorded call exactly, and a narrower rule
 * is the safe direction for something the user has not inspected yet. Dropping a
 * field afterwards is an explicit act, and the dialog then names that field.
 */
export function initialSelection(
  fields: readonly CallField[],
): readonly string[] {
  return fields.map((field) => field.id);
}

/** The recorded values this draft leaves unconstrained, in display order. */
export function unconstrainedFields(
  fieldSet: CallFieldSet,
  selected: readonly string[],
): readonly UnconstrainedField[] {
  return [
    ...fieldSet.fields
      .filter((field) => !selected.includes(field.id))
      .map((field) => ({
        id: field.id,
        label: field.label,
        kind: 'deselected' as const,
      })),
    ...fieldSet.unpinnable.map((field) => ({
      id: field.id,
      label: field.label,
      kind: field.reason,
    })),
  ];
}

/**
 * Build the draft rule from the selected fields.
 *
 * Only the selected fields become conditions, and a rule with no selection is
 * not a draft at all (`null`) rather than an unscoped rule the user never asked
 * for. Two or more conditions are conjoined with `all`, so pinning a second
 * field narrows the rule instead of widening it.
 *
 * The comment names the source call so a later reader can replay it; it is an
 * ordinary editable note and grants nothing.
 */
export function draftRuleFromCall(options: {
  readonly rules: readonly DraftRule[];
  readonly fields: readonly CallField[];
  readonly selected: readonly string[];
  readonly verdict: RuleVerdict;
  readonly comment: string;
}): DraftRule | null {
  const chosen = options.fields.filter((field) =>
    options.selected.includes(field.id),
  );
  if (chosen.length === 0) return null;
  return {
    id: nextRuleId(options.rules),
    ...(chosen.length > 1 ? { combine: 'all' as const } : {}),
    conditions: chosen.map((field) => ({
      target: field.path === null ? ('tool' as const) : ('argument' as const),
      ...(field.path === null ? {} : { path: field.path }),
      kind: 'exact' as const,
      pattern: field.pattern,
    })),
    verdict: options.verdict,
    enabled: true,
    comment: options.comment,
  };
}
