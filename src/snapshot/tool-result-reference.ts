/** Small durable observation anchors; the host event owns ordering. */
import type {
  ToolContentState,
  ToolResultReceipt,
  ToolResultSave,
  ToolResultStatus,
} from '../audit/tool-result-types.js';
import { recordOf } from '../records.js';
import type { SessionEventLike } from './types.js';
import { eventRecord } from './event-content.js';

export const RESULT_REFERENCE = 'plugin:arbiter/result-reference';
export interface ResultReference {
  readonly version: 1;
  readonly sessionId: string;
  readonly callId: string;
  readonly tool: string;
  readonly status: ToolResultStatus;
  readonly contentState: ToolContentState;
  readonly save: ToolResultSave['state'];
  readonly receipt: ToolResultReceipt | null;
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 4096;
}
function receiptOf(value: unknown, sessionId: string, callId: string) {
  return eventRecord(value) &&
    value['sessionId'] === sessionId &&
    value['callId'] === callId &&
    identifier(value['resultId'])
    ? { sessionId, callId, resultId: value['resultId'] }
    : null;
}
export function resultReference(
  event: SessionEventLike,
  sessionId: string,
): ResultReference | null {
  if (event.type !== RESULT_REFERENCE) return null;
  const data = recordOf(event)?.data;
  if (
    !eventRecord(data) ||
    data['version'] !== 1 ||
    data['sessionId'] !== sessionId ||
    !identifier(data['callId']) ||
    !identifier(data['tool'])
  )
    return null;
  const status = data['status'];
  const contentState = data['contentState'];
  const save = data['save'];
  if (!validStatus(status) || !validContent(contentState) || !validSave(save))
    return null;
  return {
    version: 1,
    sessionId,
    callId: data['callId'],
    tool: data['tool'],
    status,
    contentState,
    save,
    receipt: receiptOf(data['receipt'], sessionId, data['callId']),
  };
}

function validStatus(value: unknown): value is ToolResultStatus {
  return (
    typeof value === 'string' &&
    ['success', 'failure', 'unknown'].includes(value)
  );
}
function validContent(value: unknown): value is ToolContentState {
  return (
    typeof value === 'string' &&
    ['available', 'empty', 'no-result', 'unsupported', 'unavailable'].includes(
      value,
    )
  );
}
function validSave(value: unknown): value is ToolResultSave['state'] {
  return (
    typeof value === 'string' &&
    [
      'saved',
      'already-recorded',
      'failed',
      'stale',
      'expired',
      'unavailable',
    ].includes(value)
  );
}
