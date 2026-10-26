/**
 * Reading one Arbiter denial out of the session log.
 *
 * The client does not keep its own approval state. A denial is already a
 * durable fact: the host records the `tool/result` the plugin returned, and
 * that event carries the structured failure identity beside the model-facing
 * text (`error: { name, code, reason? }`). This module turns that identity into
 * the small, locale-neutral view a row can render, and it answers `null` for
 * every outcome that is not Arbiter's own refusal — most importantly a call
 * Arbiter allowed whose body then failed in the host sandbox, which is the
 * host's failure to present and must never be relabelled as a denial.
 *
 * Nothing here widens the recorded reason. The feedback text the agent received
 * is shown as recorded, and the stage classification only chooses which
 * sentence explains the source; it never rewrites the reason it names.
 */

import type { ArbiterDenialSource, ArbiterDenialView } from '../view-types.js';

/** The failure identity Arbiter's own `deny()` has always written. */
export const ARBITER_DENIED_ERROR_NAME = 'ArbiterDeniedError';
export const ARBITER_DENIED_CODE = 'ARBITER_DENIED';

/**
 * The bracketed outcome tags the host half's feedback text uses.
 *
 * `feedback.ts` tags every blocked call `Not executed [<tag>]: …`, so the tag is
 * the one place the stage that actually ended the call is still readable after
 * the fact. The tags are read, never produced, here.
 */
const SOURCE_BY_TAG: Readonly<Record<string, ArbiterDenialSource>> = {
  'deny-rule': 'rule',
  'review-deny': 'review',
  'fallback-deny': 'fallback',
  'human-deny': 'human',
  'human-abort': 'abort',
  'boundary-unconfirmed': 'boundary',
};

/** `Not executed [review-deny]: …` — the tag is the first bracketed word. */
const TAG_PATTERN = /^\s*Not executed \[([a-z0-9-]+)\]/u;

/**
 * The longest one-line reason a collapsed row shows.
 *
 * This bounds the row, not the record: the detail view shows the full text, and
 * the truncation is reported as a fact rather than applied silently.
 */
export const DENIAL_REASON_MAX_CHARS = 160;

/** The stage named by the recorded feedback text, when it says one. */
function sourceOfReason(reason: string | null): ArbiterDenialSource | null {
  if (reason === null) return null;
  const matched = TAG_PATTERN.exec(reason);
  if (matched === null) return null;
  const tag = matched[1];
  if (tag === undefined) return null;
  return SOURCE_BY_TAG[tag] ?? null;
}

/**
 * One line for the collapsed row.
 *
 * Line breaks and runs of spaces are folded so a multi-paragraph agent-facing
 * text does not stretch the row; the text itself is otherwise untouched.
 */
function oneLine(reason: string): string {
  return reason
    .replace(/[\r\n\u2028\u2029]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * Classify one recorded denial.
 *
 * @param error - `tool/result.error` as the session log stored it.
 * @returns the denial view, or `null` for any result Arbiter did not deny.
 */
export function denialOf(error: unknown): ArbiterDenialView | null {
  if (typeof error !== 'object' || error === null) return null;
  const record: Readonly<Record<string, unknown>> = { ...error };
  if (record['name'] !== ARBITER_DENIED_ERROR_NAME) return null;
  if (record['code'] !== ARBITER_DENIED_CODE) return null;
  const raw = record['reason'];
  const reason = typeof raw === 'string' && raw.trim() !== '' ? raw : null;
  const oneLineReason = reason === null ? null : oneLine(reason);
  // A denial whose recorded reason arrived without a recognisable stage tag is
  // still a real Arbiter refusal. It is reported as unattributed rather than
  // guessed into "the user rejected it" or any other stage.
  const source = sourceOfReason(reason) ?? 'unattributed';
  if (oneLineReason === null) {
    return {
      source,
      reason: null,
      truncated: false,
      fullReason: reason,
    };
  }
  const truncated = oneLineReason.length > DENIAL_REASON_MAX_CHARS;
  return {
    source,
    reason: truncated
      ? `${oneLineReason.slice(0, DENIAL_REASON_MAX_CHARS - 1).trimEnd()}…`
      : oneLineReason,
    truncated,
    fullReason: reason,
  };
}
