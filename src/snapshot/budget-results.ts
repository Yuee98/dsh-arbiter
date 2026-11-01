/** Shorten result bodies while retaining observed channel and media identities. */
import { eventRecord } from './event-content.js';
import { jsonFragment, shortenedText } from './budget-text.js';

const TEXT_KEYS = new Set(['text', 'stdout', 'stderr', 'output', 'content']);
const IDENTITY_KEYS = new Set([
  'type',
  'channel',
  'source',
  'ref',
  'reference',
  'uri',
  'url',
  'mimeType',
  'mime_type',
  'media_type',
]);

function labelled(value: unknown): boolean {
  return (
    eventRecord(value) &&
    ['type', 'channel', 'source', 'ref'].some((key) => key in value)
  );
}

function wholeCopy(value: unknown, scale: number): unknown {
  if (Array.isArray(value) && value.some(labelled))
    return value.map((entry: unknown) => resultCopy(entry, scale, true));
  if (eventRecord(value)) {
    const hasIdentity = labelled(value);
    const identity: [string, unknown][] = [];
    const body: [string, unknown][] = [];
    for (const [key, entry] of Object.entries(value)) {
      if (
        hasIdentity &&
        (IDENTITY_KEYS.has(key) ||
          (value['state'] === 'omitted' && (key === 'state' || key === 'note')))
      )
        identity.push([key, entry]);
      else if (Array.isArray(entry) && entry.some(labelled))
        identity.push([key, wholeCopy(entry, scale)]);
      else body.push([key, entry]);
    }
    if (identity.length > 0)
      return {
        ...Object.fromEntries(identity),
        ...(body.length === 0
          ? {}
          : { fragment: jsonFragment(Object.fromEntries(body), scale) }),
      };
  }
  return jsonFragment(value, scale);
}

export function resultCopy(
  value: unknown,
  scale: number,
  whole = false,
): unknown {
  if (scale >= 1) return value;
  if (typeof value === 'string')
    return shortenedText(value, Math.floor(value.length * scale));
  if (whole) return wholeCopy(value, scale);
  if (Array.isArray(value))
    return value.map((entry: unknown) => resultCopy(entry, scale));
  if (
    eventRecord(value) &&
    Object.keys(value).some((key) => TEXT_KEYS.has(key))
  )
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        TEXT_KEYS.has(key) ? resultCopy(item, scale) : item,
      ]),
    );
  if (labelled(value)) return wholeCopy(value, scale);
  return jsonFragment(value, scale);
}
