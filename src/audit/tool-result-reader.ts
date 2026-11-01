import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type {
  ToolResultMetadata,
  ToolResultRead,
  ToolResultReceipt,
} from './tool-result-types.js';
import { asRow, isRecord, rowText } from './rows.js';
import { missingResultFile, readToolResultFile } from './tool-result-files.js';
import { MAX_RESULT_BYTES } from './tool-result-slicing.js';

export function emptyToolResult(
  state: ToolResultRead['state'],
): ToolResultRead {
  return {
    state,
    receipt: null,
    metadata: null,
    storage: null,
    fileRef: null,
    failure: null,
    fragments: [],
  };
}
function nullableString(value: unknown): boolean {
  return value === null || typeof value === 'string';
}
function natural(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}
function validPart(value: unknown): boolean {
  return (
    isRecord(value) &&
    typeof value['channel'] === 'string' &&
    nullableString(value['source']) &&
    ['text', 'json', 'media'].includes(rowText(value['kind'])) &&
    natural(value['start']) &&
    natural(value['bytes']) &&
    nullableString(value['mediaType']) &&
    nullableString(value['reference'])
  );
}
function validRange(
  value: unknown,
): value is { readonly start: number; readonly end: number } {
  return (
    isRecord(value) &&
    natural(value['start']) &&
    natural(value['end']) &&
    value['end'] >= value['start']
  );
}
function metadataOf(text: string): ToolResultMetadata | null {
  if (Buffer.byteLength(text) > MAX_RESULT_BYTES) return null;
  const value: unknown = JSON.parse(text);
  if (!isMetadata(value)) return null;
  if (
    value.ranges.length > 2 ||
    value.ranges.reduce(
      (bytes, range) => bytes + range.end - range.start,
      0,
    ) !== value.retainedBytes
  )
    return null;
  if (
    value.ranges.some(
      (range, index) =>
        range.end > value.sourceBytes ||
        range.start < (value.ranges[index - 1]?.end ?? 0),
    )
  )
    return null;
  return value;
}
function validState(value: Record<string, unknown>): boolean {
  return (
    ['success', 'failure', 'unknown'].includes(rowText(value['status'])) &&
    ['available', 'empty', 'no-result', 'unsupported', 'unavailable'].includes(
      rowText(value['contentState']),
    ) &&
    typeof value['observedAt'] === 'number' &&
    (value['callStartedAt'] === null ||
      typeof value['callStartedAt'] === 'number') &&
    nullableString(value['unavailableReason']) &&
    typeof value['upstreamTruncated'] === 'boolean' &&
    (value['localTruncation'] === null ||
      value['localTruncation'] === 'collection-limit')
  );
}
function validSize(value: Record<string, unknown>): boolean {
  return (
    natural(value['sourceBytes']) &&
    natural(value['retainedBytes']) &&
    value['retainedBytes'] <= MAX_RESULT_BYTES &&
    typeof value['sha256'] === 'string' &&
    /^[a-f0-9]{64}$/u.test(value['sha256'])
  );
}
function isMetadata(value: unknown): value is ToolResultMetadata {
  if (!isRecord(value)) return false;
  return (
    value['version'] === 1 &&
    value['processingVersion'] === 'tool-result-v1' &&
    validState(value) &&
    validSize(value) &&
    Array.isArray(value['ranges']) &&
    value['ranges'].every(validRange) &&
    Array.isArray(value['parts']) &&
    value['parts'].every(validPart) &&
    Object.hasOwn(value, 'origin')
  );
}
export function resultReceipt(
  db: DatabaseSync,
  sessionId: string,
  callId: string,
): ToolResultReceipt | null {
  const row = asRow(
    db
      .prepare(
        'SELECT result_id FROM tool_results WHERE session_id = ? AND call_id = ?',
      )
      .get(sessionId, callId),
  );
  const resultId = rowText(row['result_id']);
  return resultId === '' ? null : { sessionId, callId, resultId };
}
export function readToolResult(
  db: DatabaseSync,
  path: string,
  sessionId: string,
  callId: string,
  expected?: ToolResultReceipt,
): ToolResultRead {
  const value = db
    .prepare('SELECT * FROM tool_results WHERE session_id = ? AND call_id = ?')
    .get(sessionId, callId);
  if (value === undefined)
    return emptyToolResult(expected === undefined ? 'absent' : 'cleared');
  const row = asRow(value);
  const receipt = { sessionId, callId, resultId: rowText(row['result_id']) };
  if (expected !== undefined && expected.resultId !== receipt.resultId)
    return emptyToolResult('cleared');
  const failure = typeof row['failure'] === 'string' ? row['failure'] : null;
  if (row['storage'] === 'failed')
    return {
      ...emptyToolResult('storage-failed'),
      receipt,
      storage: 'failed',
      failure,
    };
  const storage = row['storage'];
  if (storage !== 'inline' && storage !== 'file' && storage !== 'none')
    return emptyToolResult('unreadable');
  const fileRef = typeof row['file_ref'] === 'string' ? row['file_ref'] : null;
  const base: ToolResultRead = {
    ...emptyToolResult('unreadable'),
    receipt,
    storage,
    fileRef,
    failure,
  };
  const result = readStoredBody(row, path, base);
  if (
    result.state === 'missing-file' &&
    resultReceipt(db, sessionId, callId)?.resultId !== receipt.resultId
  )
    return { ...emptyToolResult('cleared'), receipt };
  return result;
}
function readStoredBody(
  row: Record<string, unknown>,
  path: string,
  base: ToolResultRead,
): ToolResultRead {
  let metadata: ToolResultMetadata | null = null;
  try {
    metadata = metadataOf(rowText(row['metadata']));
    if (metadata === null) return base;
    const body =
      base.storage === 'file'
        ? readToolResultFile(
            path,
            base.fileRef ?? '',
            metadata.retainedBytes,
            metadata.sha256,
          )
        : Buffer.from(rowText(row['body']));
    if (
      body.length !== metadata.retainedBytes ||
      createHash('sha256').update(body).digest('hex') !== metadata.sha256 ||
      !Buffer.from(body.toString('utf8')).equals(body)
    )
      return { ...base, metadata };
    let offset = 0;
    const fragments = metadata.ranges.map((range) => {
      const text = body
        .subarray(offset, offset + range.end - range.start)
        .toString('utf8');
      offset += range.end - range.start;
      return { ...range, text };
    });
    return { ...base, state: 'found', metadata, fragments };
  } catch (error) {
    return {
      ...base,
      state: missingResultFile(error) ? 'missing-file' : 'unreadable',
      metadata,
    };
  }
}
