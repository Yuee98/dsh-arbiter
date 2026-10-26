/**
 * Loading one call detail by `callId`.
 *
 * This is the shared open path: the log list and, later, a session tool-call
 * entry both hand a `callId` here rather than reading the audit store
 * themselves. A superseded request is dropped instead of overwriting the detail
 * the user is now looking at.
 */

import { ApiError, getJson } from '../api.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { callDetailResponse } from '../decoders/logs.js';
import { errorText } from '../view-helpers.js';
import type { CallDetailState } from '../view-types.js';

/** Map one failed read onto the state the panel renders. */
function stateOfError(error: unknown): CallDetailState {
  if (error instanceof ApiError) {
    if (error.code === 'record-unavailable')
      return { kind: 'record-unavailable' };
    if (error.code === 'audit-unavailable')
      return { kind: 'audit-unavailable' };
  }
  return { kind: 'failed', message: errorText(error) };
}

export interface CallDetailLoader {
  readonly state: CallDetailState;
  /** Retry the current call id, e.g. after the audit store became available. */
  readonly reload: () => void;
}

/**
 * Read one detail whenever the target changes.
 *
 * `null` means nothing is open: the panel still reports that it is loading
 * nothing rather than claiming a record is missing.
 */
export function useCallDetail(callId: string | null): CallDetailLoader {
  const [state, setState] = useState<CallDetailState>({ kind: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const generation = useRef(0);
  const reload = useCallback(() => {
    setAttempt((current) => current + 1);
  }, []);

  useEffect(() => {
    if (callId === null) {
      setState({ kind: 'loading' });
      return;
    }
    const ticket = generation.current + 1;
    generation.current = ticket;
    setState({ kind: 'loading' });
    getJson(
      `/log?callId=${encodeURIComponent(callId)}`,
      callDetailResponse,
    ).then(
      (detail) => {
        if (generation.current !== ticket) return;
        setState({ kind: 'ready', detail });
      },
      (error: unknown) => {
        if (generation.current !== ticket) return;
        setState(stateOfError(error));
      },
    );
  }, [callId, attempt]);

  return { state, reload };
}
