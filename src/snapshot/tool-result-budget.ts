/** Budget only the text of a receipt-verified retained result, never its identity. */
import type { ToolBodyFragment } from '../audit/tool-result-types.js';
import { eventRecord } from './event-content.js';
import { resultCopy } from './budget-results.js';
import { textFragment } from './budget-text.js';

function fragment(value: unknown): value is ToolBodyFragment {
  return (
    eventRecord(value) &&
    typeof value['start'] === 'number' &&
    typeof value['end'] === 'number' &&
    typeof value['text'] === 'string' &&
    Number.isSafeInteger(value['start']) &&
    Number.isSafeInteger(value['end']) &&
    value['start'] >= 0 &&
    value['end'] >= value['start'] &&
    Buffer.byteLength(value['text']) === value['end'] - value['start']
  );
}
function fragmentCopy(value: unknown, scale: number): readonly unknown[] {
  if (!fragment(value)) return [value];
  const copy = textFragment(
    value.text,
    Math.floor(value.text.length * Math.max(0, scale)),
  );
  return [
    ...(copy.head.length === 0
      ? []
      : [
          {
            start: value.start,
            end: value.start + Buffer.byteLength(copy.head),
            text: copy.head,
          },
        ]),
    ...(copy.tail.length === 0
      ? []
      : [
          {
            start: value.end - Buffer.byteLength(copy.tail),
            end: value.end,
            text: copy.tail,
          },
        ]),
  ];
}

export function resultBudgetCopy(
  value: unknown,
  scale: number,
  whole: boolean,
  retained: boolean,
): unknown {
  if (!retained) return resultCopy(value, scale, whole);
  if (scale >= 1 || !eventRecord(value) || !Array.isArray(value['fragments']))
    return value;
  return {
    ...value,
    budgetTruncated: true,
    fragments: value['fragments'].flatMap((entry: unknown) =>
      fragmentCopy(entry, scale),
    ),
  };
}
