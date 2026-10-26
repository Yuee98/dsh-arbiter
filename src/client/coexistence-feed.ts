import { useCallback, useEffect, useRef, useState } from 'react';

import { getJson, postJson } from './api.js';
import { coexistenceResponse } from './decoders/coexistence.js';
import type { CoexistenceView, StateResponse } from './view-types.js';

/**
 * How often an open page re-reads the host's provider state.
 *
 * The read is one GET of state the host already computed, so it is cheap; the
 * interval is what turns "a conflict appeared while this page was open" into a
 * visible notice instead of a stale section.
 */
export const COEXISTENCE_POLL_MS = 15_000;

/**
 * A browser-wide "the host was just re-read" signal.
 *
 * The settings page and the frame-wide overlay are independent consumers of the
 * same host state. When one of them learns something authoritative (a reload, a
 * save), it announces it here so the other refreshes immediately instead of
 * waiting for its own interval — and neither one owns a second transport.
 */
export const COEXISTENCE_REFRESH_EVENT = 'arbiter:coexistence-refresh';

/** The conflict section of a feed seed, whether it is a view or a payload. */
function sectionOf(
  seed: CoexistenceView | StateResponse | null,
): CoexistenceView | null {
  if (seed === null) return null;
  return 'coexistence' in seed ? seed.coexistence : seed;
}

/** Tell every mounted consumer to re-read the host now. */
export function requestCoexistenceRefresh(): void {
  document.dispatchEvent(new Event(COEXISTENCE_REFRESH_EVENT));
}

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
  seed: CoexistenceView | StateResponse | null,
  onError: (failure: unknown) => void = () => undefined,
): CoexistenceFeed {
  const [view, setView] = useState<CoexistenceView | null>(sectionOf(seed));
  /**
   * The newest request this consumer accepted.
   *
   * A GET that started before an acknowledgement can return after it. Arrival
   * order is not age order, so every accepted response advances this counter and
   * a response from an older request is dropped instead of reviving a notice the
   * user already dismissed.
   */
  const accepted = useRef(0);
  /**
   * Whether an acknowledgement is in flight.
   *
   * A background GET that starts while a POST is pending can reach the host
   * first and legitimately return the pre-acknowledgement view. Ordering by
   * request start cannot tell which of those two reflects the newer host state,
   * so the read is skipped instead of guessed: one refresh runs when the POST
   * settles, and that response is authoritative.
   */
  const pendingAck = useRef(false);
  /**
   * Reserve a ticket when the request starts, not when it answers.
   *
   * Reserving at allocation is what makes the rule "an older request can never
   * win": two in-flight requests already have distinct ages even though neither
   * has answered, so the later one wins regardless of arrival order.
   */
  const nextTicket = useCallback((): number => {
    accepted.current += 1;
    return accepted.current;
  }, []);
  const accept = useCallback(
    (ticket: number, next: CoexistenceView | null): void => {
      if (ticket < accepted.current) return;
      setView(next);
    },
    [],
  );

  // A page load (or a save-triggered reload) replaces the confirmed state.
  useEffect(() => {
    setView(sectionOf(seed));
    accepted.current = nextTicket();
    // A payload seed means the page just re-read the host, so the *other*
    // consumer refreshes too: they share one transport, not two.
    if (seed !== null && 'coexistence' in seed) requestCoexistenceRefresh();
  }, [seed, nextTicket]);

  useEffect(() => {
    const refresh = (): void => {
      if (pendingAck.current) return;
      const ticket = nextTicket();
      getJson('/coexistence', coexistenceResponse)
        .then((response) => {
          accept(ticket, response.coexistence);
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
    document.addEventListener(COEXISTENCE_REFRESH_EVENT, refresh);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      document.removeEventListener(COEXISTENCE_REFRESH_EVENT, refresh);
    };
  }, [accept, nextTicket]);

  const acknowledge = useCallback(
    (ids: readonly string[]): void => {
      if (pendingAck.current) return;
      pendingAck.current = true;
      const ticket = nextTicket();
      postJson('/coexistence', { noticeIds: ids }, coexistenceResponse)
        .then((response) => {
          pendingAck.current = false;
          accept(ticket, response.coexistence);
        })
        .catch((failure: unknown) => {
          pendingAck.current = false;
          onError(failure);
        });
    },
    [accept, nextTicket, onError],
  );
  return { view, acknowledge };
}
