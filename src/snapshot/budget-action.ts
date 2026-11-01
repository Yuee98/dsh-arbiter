/** Only the review copy changes; execution arguments remain caller-owned. */
import type { ReviewSnapshot } from '../types.js';
import { shortenedText, textFragment } from './budget-text.js';

type Action = ReviewSnapshot['action'];

function wholeAction(action: Action, scale: number): Action {
  const { programText, ...rest } = action;
  const text = JSON.stringify({
    arguments: action.arguments,
    ...(programText === undefined ? {} : { programText }),
  });
  const keep = Math.floor(text.length * Math.max(0, scale));
  const fragment = textFragment(text, keep);
  const copy = shortenedText(text, keep);
  return {
    ...rest,
    arguments: {
      format: 'json-fragment',
      note: 'Incomplete serialized pending-action fields, not executable arguments.',
      text: copy,
    },
    truncated: {
      originalChars: text.length,
      retainedChars: copy.length,
      field: null,
      omittedFrom: fragment.omittedFrom,
      omittedTo: fragment.omittedTo,
    },
  };
}

export function scaledAction(
  action: Action,
  scale: number,
  whole = false,
): Action {
  if (scale >= 1) return action;
  const args = action.arguments;
  const record =
    args !== null && typeof args === 'object' && !Array.isArray(args)
      ? Object.fromEntries(Object.entries(args))
      : null;
  const field =
    record === null
      ? undefined
      : ['code', 'program', 'command'].find(
          (key) => typeof record[key] === 'string',
        );
  if (whole || field === undefined) return wholeAction(action, scale);
  const value: unknown = record?.[field];
  if (typeof value !== 'string') return wholeAction(action, scale);
  const keep = Math.floor(value.length * Math.max(0, scale));
  const fragment = textFragment(value, keep);
  const copy = shortenedText(value, keep);
  return {
    ...action,
    arguments: { ...record, [field]: copy },
    ...(action.programText === value ? { programText: copy } : {}),
    truncated: {
      originalChars: value.length,
      retainedChars: copy.length,
      field,
      omittedFrom: fragment.omittedFrom,
      omittedTo: fragment.omittedTo,
    },
  };
}
