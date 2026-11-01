/** Project final runtime output through the existing credential/media policy. */
import type {
  ToolContentState,
  ToolResultPart,
  ToolResultStatus,
} from '../audit.js';
import { validateResultJson } from '../audit/tool-result-json.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { eventRecord, resultContent } from '../snapshot/event-content.js';
import {
  discoverSourceContent,
  redactSourceContent,
} from '../snapshot/source-redaction.js';
import type { ToolResultLike } from './types.js';

export function resultStatus(result: ToolResultLike): ToolResultStatus {
  return result.isError === true
    ? 'failure'
    : result.isError === false
      ? 'success'
      : 'unknown';
}
function channel(value: Record<string, unknown>): string {
  return typeof value['channel'] === 'string' ? value['channel'] : 'content';
}
function part(value: unknown): ToolResultPart {
  if (typeof value === 'string')
    return { kind: 'text', channel: 'content', text: value };
  if (!eventRecord(value)) return { kind: 'json', channel: 'content', value };
  const source =
    typeof value['source'] === 'string' ? { source: value['source'] } : {};
  if (value['state'] === 'omitted' && typeof value['type'] === 'string')
    return {
      kind: 'media',
      channel: channel(value),
      ...source,
      mediaType: value['type'],
      ...(typeof value['ref'] === 'string' ? { reference: value['ref'] } : {}),
    };
  if (value['type'] === 'text' && typeof value['text'] === 'string')
    return {
      kind: 'text',
      channel: channel(value),
      ...source,
      text: value['text'],
    };
  return { kind: 'json', channel: channel(value), ...source, value };
}
function mirror(content: unknown, value: unknown): boolean {
  if (value !== undefined && JSON.stringify(content) === JSON.stringify(value))
    return true;
  if (value === undefined || !Array.isArray(content) || content.length !== 1)
    return false;
  const first: unknown = content[0];
  return (
    eventRecord(first) &&
    first['type'] === 'text' &&
    typeof first['text'] === 'string' &&
    parsedMirror(first['text'], value)
  );
}
function parsedMirror(text: string, value: unknown): boolean {
  try {
    return JSON.stringify(JSON.parse(text)) === JSON.stringify(value);
  } catch {
    return false;
  }
}
function contentState(
  content: unknown,
  value: unknown,
  parts: readonly ToolResultPart[],
): ToolContentState {
  if (content === undefined && value === undefined) return 'no-result';
  if (parts.length > 0 && parts.every((entry) => entry.kind === 'media'))
    return 'unsupported';
  return parts.every(
    (entry) => entry.kind === 'text' && entry.text.length === 0,
  )
    ? 'empty'
    : 'available';
}
export interface ResultMaterial {
  readonly contentState: ToolContentState;
  readonly parts: readonly ToolResultPart[];
  readonly unavailableReason?: string;
  readonly upstreamTruncated?: boolean;
}
function truncated(value: unknown): boolean {
  if (!eventRecord(value)) return false;
  return (
    value['truncated'] === true ||
    ['stdout', 'stderr'].some((key) => {
      const channel = value[key];
      return eventRecord(channel) && channel['truncated'] === true;
    })
  );
}
export function toolResultMaterial(
  result: ToolResultLike,
  redactor: CredentialRedactor,
): ResultMaterial {
  try {
    const content: unknown = result.content;
    const value: unknown = result.value;
    if (content !== undefined) {
      validateResultJson(content);
      discoverSourceContent(content, redactor);
    }
    if (value !== undefined) {
      validateResultJson(value);
      redactor.discover(value);
    }
    const projected =
      content === undefined
        ? undefined
        : redactSourceContent(resultContent(content), redactor);
    const parts =
      projected === undefined
        ? []
        : (Array.isArray(projected) ? projected : [projected]).map(part);
    if (value !== undefined && !mirror(content, value)) {
      const safe = redactor.value(resultContent(value));
      parts.push(
        eventRecord(safe) && safe['state'] === 'omitted'
          ? part(safe)
          : { kind: 'json', channel: 'value', value: safe },
      );
    }
    return {
      contentState: contentState(content, value, parts),
      parts,
      ...(truncated(value) ? { upstreamTruncated: true } : {}),
    };
  } catch {
    return {
      contentState: 'unavailable',
      parts: [],
      unavailableReason: 'result-processing-failed',
    };
  }
}
