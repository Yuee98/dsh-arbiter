import { useCallback, useEffect, useState } from 'react';

import { getJson, postJson } from './api.js';
import { coexistenceResponse } from './decoders/coexistence.js';
import type { CoexistenceView } from './view-types.js';

/**
 * How often an open page re-reads the host's provider state.
 *
 * The read is one GET of state the host already computed, so it is cheap; the
 * interval is what turns "a conflict appeared while this page was open" into a
 * visible notice instead of a stale section.
 */
export const COEXISTENCE_POLL_MS = 15_000;

export interface CoexistenceFeed {
  readonly view: CoexistenceView | null;
  /** Mark visible reminders as read; the conflict itself stays in `view`. */
  readonly acknowledge: (ids: readonly string[]) => void;
}

/**
 * Keep one coexistence view current.
 *
 * The section describes the host, not the document being edited, so it has its
 * own route and its own refresh: polling it never reloads the draft underneath
 * the user. A failed poll is silent (the section keeps the last confirmed
 * state); a failed acknowledgement is reported, because the user asked for it.
 */
export function useCoexistenceFeed(
  initial: CoexistenceView | null,
  onError: (failure: unknown) => void = () => undefined,
): CoexistenceFeed {
  const [view, setView] = useState<CoexistenceView | null>(initial);

  // A page load (or a save-triggered reload) replaces the confirmed state.
  useEffect(() => {
    setView(initial);
  }, [initial]);

  useEffect(() => {
    const refresh = (): void => {
      getJson('/coexistence', coexistenceResponse)
        .then((response) => {
          setView(response.coexistence);
        })
        .catch(() => undefined);
    };
    // A mount is the first observation: an overlay that only polled later would
    // miss a conflict already standing when the page opened.
    refresh();
    const timer = setInterval(refresh, COEXISTENCE_POLL_MS);
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') refresh();
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, []);

  const acknowledge = useCallback(
    (ids: readonly string[]): void => {
      postJson('/coexistence', { noticeIds: ids }, coexistenceResponse)
        .then((response) => {
          setView(response.coexistence);
        })
        .catch(onError);
    },
    [onError],
  );
  return { view, acknowledge };
}
