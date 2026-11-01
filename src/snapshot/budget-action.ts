/** Only the review copy changes; execution arguments remain caller-owned. */
import type { ReviewSnapshot } from '../types.js';
import { shortenedText, textFragment } from './budget-text.js';

export function scaledAction(
  action: ReviewSnapshot['action'],
  scale: number,
): ReviewSnapshot['action'] {
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
  const value: unknown = field === undefined ? args : record?.[field];
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (scale >= 1) return action;
  const keep = Math.floor(text.length * Math.max(0, scale));
  const fragment = textFragment(text, keep);
  const copy = shortenedText(text, keep);
  return {
    ...action,
    arguments:
      field === undefined
        ? {
            format: 'json-fragment',
            note: 'Incomplete review copy, not a complete command.',
            ...fragment,
          }
        : { ...record, [field]: copy },
    ...(action.programText === undefined &&
    field !== 'code' &&
    field !== 'program'
      ? {}
      : { programText: copy }),
    truncated: {
      originalChars: text.length,
      retainedChars: copy.length,
      field: field ?? null,
      omittedFrom: fragment.omittedFrom,
      omittedTo: fragment.omittedTo,
    },
  };
}
