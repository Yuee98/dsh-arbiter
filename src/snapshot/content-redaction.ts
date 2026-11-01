/** Protocol tags have finite public meanings; material values still use one redactor. */
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { uniqueCredentialRecord } from '../reviewer/credential-record.js';

const TAGS = new Set([
  'text',
  'reasoning',
  'image',
  'audio',
  'file',
  'tool-call',
  'tool-addition',
  'tool-removal',
]);
const IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/webp',
  'image/gif',
]);
const FIELDS = new Set([
  'type',
  'text',
  'attachment',
  'reference',
  'ref',
  'mimeType',
  'mediaType',
  'omission',
  'annotations',
  'name',
  'width',
  'height',
  'bytes',
  'originalDimensions',
  'attachmentId',
  'offloaded',
  'id',
  'toolName',
  'arguments',
]);
const ATTACHMENT_FIELDS = new Set([
  'attachmentId',
  'mediaType',
  'name',
  'bytes',
  'width',
  'height',
  'originalDimensions',
]);
const DIMENSIONS = new Set(['width', 'height']);
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function metadata(
  value: Record<string, unknown>,
  fields: ReadonlySet<string>,
  redactor: CredentialRedactor,
): Record<string, unknown> {
  const material = redactor.value(
    Object.fromEntries(
      Object.entries(value).filter(([key]) => !fields.has(key)),
    ),
  );
  if (!record(material))
    throw new Error('credential source metadata could not be safely copied');
  const fixed = Object.entries(value)
    .filter(([key]) => fields.has(key))
    .map(([key, item]): [string, unknown] => {
      if (
        (key === 'mediaType' || key === 'mimeType') &&
        typeof item === 'string' &&
        IMAGE_TYPES.has(item)
      )
        return [key, item];
      if (key === 'originalDimensions' && record(item))
        return [key, metadata(item, DIMENSIONS, redactor)];
      return [key, redactor.value(item)];
    });
  return uniqueCredentialRecord([...Object.entries(material), ...fixed]);
}
export function copySourceBlock(
  block: unknown,
  redactor: CredentialRedactor,
  text?: string,
): unknown {
  if (
    !record(block) ||
    typeof block['type'] !== 'string' ||
    !TAGS.has(block['type'])
  )
    return redactor.value(block);
  const tag = block['type'];
  const input = Object.fromEntries(
    Object.entries(block).filter(
      ([key]) =>
        key !== 'type' &&
        (key !== 'text' || text === undefined) &&
        key !== 'attachment',
    ),
  );
  redactor.discover(input);
  redactor.discover(block['attachment']);
  const copied = metadata(input, FIELDS, redactor);
  const entries: [string, unknown][] = [
    ...Object.entries(copied),
    ['type', tag],
  ];
  if (text !== undefined) entries.push(['text', text]);
  if (block['attachment'] !== undefined) {
    const attachment = block['attachment'];
    entries.push([
      'attachment',
      record(attachment)
        ? metadata(attachment, ATTACHMENT_FIELDS, redactor)
        : redactor.value(attachment),
    ]);
  }
  return uniqueCredentialRecord(entries);
}
