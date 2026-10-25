/**
 * The one place the selector talks to its two authorities.
 *
 * Admission reads and writes go to the Arbiter admission API, the only source
 * of "is this session admitted". The host's own `/permission <preset>` command
 * is used only to leave Arbiter — and only the command, because #4 already
 * disables the admission on a successful command and leaves it alone on a
 * failed one. A client-side disable first would exit admission even when the
 * host command then failed.
 *
 * Two ordering rules keep the displayed value honest:
 *   - a newer *issued* request wins (a late answer is dropped), and
 *   - a write is a barrier: reads requested while it is in flight are coalesced
 *     into one read after it settles, because a read that was merely issued
 *     later can still be answered from an older server state.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { getAdmission, setAdmission } from './api.js';
import {
  EMPTY_ADMISSION_STATE,
  confirmed,
  failed,
  failureFromAnswer,
  failureOf,
  queueRead,
  started,
  writing,
} from './permission-selector-state.js';
import type {
  AdmissionFailure,
  AdmissionState,
} from './permission-selector-state.js';
import type {
  AdmissionAction,
  HostBridge,
  HostPermissionCatalogOption,
  HostPresetSelection,
  SessionAdmissionResponse,
} from './view-types.js';

export interface AdmissionController {
  readonly state: AdmissionState;
  /** The host's own presets, or `null` when that surface is unavailable. */
  readonly catalog: readonly HostPermissionCatalogOption[] | null;
  /** The host's *current* preset, for the label when Arbiter is not enabled. */
  readonly hostPreset: HostPresetSelection | null;
  /** Enable or disable this session; the confirmation is the server's answer. */
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  /** Leave Arbiter and apply one host preset through the host's own command. */
  readonly chooseHostPreset: (preset: string) => Promise<void>;
}

/** One request's claim on the newest answer; an older claim never writes. */
interface Ticket {
  readonly value: number;
  readonly session: string;
}

/**
 * The stable operations of one session's flow.
 *
 * Kept separate from the state object so an effect can depend on them without
 * re-running on every render: the state changes on every answer, the
 * operations do not change until the session identity does.
 */
interface FlowOps {
  readonly next: () => Ticket;
  readonly current: (ticket: Ticket) => boolean;
  readonly apply: (answer: SessionAdmissionResponse) => void;
  readonly reset: () => void;
  readonly markStarted: () => void;
  readonly markWriting: () => void;
  readonly markQueued: () => void;
  readonly markFailed: (failure: AdmissionFailure) => void;
  readonly markError: (ticket: Ticket, error: unknown) => void;
}

/** Ticket-guarded answers; a superseded answer is dropped, never replayed. */
function useFlow(sessionId: string | undefined): {
  readonly state: AdmissionState;
  readonly ops: FlowOps;
} {
  const [state, setState] = useState<AdmissionState>(EMPTY_ADMISSION_STATE);
  const generation = useRef(0);
  const active = useRef(true);
  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  const next = useCallback((): Ticket => {
    generation.current += 1;
    return { value: generation.current, session: sessionId ?? '' };
  }, [sessionId]);
  const current = useCallback(
    (ticket: Ticket): boolean =>
      active.current &&
      ticket.value === generation.current &&
      // A different session is a different state: its answer is not ours.
      ticket.session === (sessionId ?? '') &&
      ticket.session.length > 0,
    [sessionId],
  );
  const apply = useCallback((answer: SessionAdmissionResponse): void => {
    if (answer.ok) setState((old) => confirmed(old, answer.admission));
    else setState((old) => failed(old, failureFromAnswer(answer)));
  }, []);
  const reset = useCallback((): void => {
    setState(EMPTY_ADMISSION_STATE);
  }, []);
  const markStarted = useCallback((): void => {
    setState((old) => started(old));
  }, []);
  const markWriting = useCallback((): void => {
    setState((old) => writing(old));
  }, []);
  const markQueued = useCallback((): void => {
    setState((old) => queueRead(old));
  }, []);
  const markFailed = useCallback((failure: AdmissionFailure): void => {
    setState((old) => failed(old, failure));
  }, []);
  const markError = useCallback(
    (ticket: Ticket, error: unknown): void => {
      if (!current(ticket)) return;
      setState((old) => failed(old, failureOf(error)));
    },
    [current],
  );
  const ops = useMemo<FlowOps>(
    () => ({
      next,
      current,
      apply,
      reset,
      markStarted,
      markWriting,
      markQueued,
      markFailed,
      markError,
    }),
    [
      apply,
      current,
      markError,
      markFailed,
      markQueued,
      markStarted,
      markWriting,
      next,
      reset,
    ],
  );
  return { state, ops };
}

/** Re-read triggers the browser itself provides, alongside the host signals. */
function useBrowserSignals(onRefresh: () => void): void {
  useEffect(() => {
    const run = (): void => {
      onRefresh();
    };
    const onVisible = (): void => {
      if (document.visibilityState === 'visible') run();
    };
    window.addEventListener('focus', run);
    window.addEventListener('online', run);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', run);
      window.removeEventListener('online', run);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [onRefresh]);
}

/**
 * The host catalog, refreshed on its own invalidation.
 *
 * A catalog that arrives late (the Remote service became available after this
 * plugin started) and a catalog that changed must both reach the menu. Reads
 * carry a ticket so a slow earlier read cannot replace a newer one, and a failed
 * read is "unavailable" (`null`), never an empty catalog.
 */
function useHostCatalog(bridge: HostBridge | undefined): {
  readonly catalog: readonly HostPermissionCatalogOption[] | null;
  readonly refresh: () => void;
} {
  const [catalog, setCatalog] = useState<
    readonly HostPermissionCatalogOption[] | null
  >(null);
  const [revision, setRevision] = useState(0);
  const ticket = useRef(0);
  useEffect(() => {
    if (bridge === undefined) {
      setCatalog(null);
      return;
    }
    ticket.current += 1;
    const mine = ticket.current;
    let cancelled = false;
    bridge
      .catalog()
      .then((options) => {
        if (cancelled || mine !== ticket.current) return;
        setCatalog(options);
      })
      .catch(() => {
        if (!cancelled && mine === ticket.current) setCatalog(null);
      });
    return () => {
      cancelled = true;
    };
  }, [bridge, revision]);
  const refresh = useCallback((): void => {
    setRevision((value) => value + 1);
  }, []);
  return { catalog, refresh };
}

/** The current host preset; `_revision` re-reads it after an invalidation. */
function readHostPreset(
  bridge: HostBridge | undefined,
  sessionId: string | undefined,
  _revision: number,
): HostPresetSelection | null {
  if (bridge === undefined || sessionId === undefined) return null;
  return bridge.hostPreset(sessionId);
}

/** How long a native switch may take to appear in the authoritative answer. */
const EXIT_CONFIRM_ATTEMPTS = 15;
const EXIT_CONFIRM_DELAY_MS = 120;

/**
 * Confirm that a native switch really left Arbiter.
 *
 * The read is the only evidence; the loop exists because #4 writes the exit
 * record one microtask after the command handler, and the host may commit the
 * command pair before that write lands. It is bounded and authoritative — no
 * timer-driven polling of a second state.
 */
async function reconcileExit(options: {
  readonly read: () => Promise<void>;
  readonly view: () => AdmissionState['confirmed'];
}): Promise<boolean> {
  for (let attempt = 0; attempt < EXIT_CONFIRM_ATTEMPTS; attempt += 1) {
    await options.read();
    const current = options.view();
    if (current !== null && !current.enabled) return true;
    await new Promise((resolve) => {
      setTimeout(resolve, EXIT_CONFIRM_DELAY_MS);
    });
  }
  return false;
}

interface Barrier {
  readonly writing: () => boolean;
  readonly opened: () => void;
  readonly closed: () => boolean;
  readonly queue: () => void;
  /** Drop a queued read: the caller already reconciled authoritatively. */
  readonly clear: () => void;
}

/**
 * The two writes the control offers.
 *
 * Both are exclusive mutations: while one runs the control is busy and refuses
 * another selection, so an older native command can never land after a newer
 * enable and silently win. Enabling/disabling goes through the admission route.
 * Leaving Arbiter goes through the host's own `/permission` command and nothing
 * else, because #4 already owns the admission exit a successful command implies
 * and ignores a failed one.
 *
 * `matched` is recognition, not success: a matched command can still settle with
 * a handler error, so the caller always reconciles through the authoritative
 * admission read afterwards.
 */
function useAdmissionWrites(options: {
  readonly bridge: HostBridge | undefined;
  readonly sessionId: string | undefined;
  readonly ops: FlowOps;
  readonly barrier: Barrier;
  readonly read: () => Promise<void>;
  /** A reconciliation read bound to the mutation's own ticket. */
  readonly reconcileFor: (ticket: Ticket) => () => Promise<void>;
  readonly view: () => AdmissionState['confirmed'];
}): {
  readonly setEnabled: (enabled: boolean) => Promise<void>;
  readonly chooseHostPreset: (preset: string) => Promise<void>;
  readonly busy: boolean;
} {
  const { bridge, sessionId, ops, barrier, read, reconcileFor, view } = options;
  /** Busy is rendered, so the "refuse another selection" rule is visible too. */
  const [busy, setBusy] = useState(false);
  const write = useCallback(
    async (action: AdmissionAction): Promise<void> => {
      if (sessionId === undefined) {
        ops.markFailed({ code: 'session-required', detail: '' });
        return;
      }
      const ticket = ops.next();
      barrier.opened();
      ops.markWriting();
      try {
        const answer = await setAdmission(sessionId, action);
        if (!ops.current(ticket)) return;
        ops.apply(answer);
      } catch (error) {
        ops.markError(ticket, error);
      } finally {
        if (barrier.closed()) await read();
      }
    },
    [barrier, ops, read, sessionId],
  );
  const setEnabled = useCallback(
    async (nextValue: boolean): Promise<void> => {
      await write(nextValue ? 'enable' : 'disable');
    },
    [write],
  );
  const chooseHostPreset = useCallback(
    async (preset: string): Promise<void> => {
      if (bridge === undefined || sessionId === undefined) {
        ops.markFailed({ code: 'host-unavailable', detail: '' });
        return;
      }
      if (barrier.writing()) return;
      const ticket = ops.next();
      barrier.opened();
      ops.markWriting();
      setBusy(true);
      try {
        const recognized = await bridge.selectPreset(sessionId, preset);
        if (!ops.current(ticket)) return;
        if (!recognized) {
          await reconcileFor(ticket)();
          if (!ops.current(ticket)) return;
          ops.markFailed({ code: 'host-unavailable', detail: '' });
          return;
        }
        // The command being recognized is not proof it applied: #4 records the
        // exit one microtask after the handler, and a handler can settle with an
        // error. Confirm through the authoritative answer, bounded, so neither a
        // successful exit nor a refused one is misreported.
        const exit = await reconcileExit({
          read: reconcileFor(ticket),
          view,
        });
        if (!ops.current(ticket)) return;
        if (!exit) ops.markFailed({ code: 'command-not-applied', detail: '' });
      } catch (error) {
        ops.markError(ticket, error);
        return;
      } finally {
        setBusy(false);
        // The switch already reconciled through `reconcile`; any read queued
        // during it is redundant and would clear the refusal just recorded.
        barrier.clear();
        barrier.closed();
      }
    },
    [barrier, bridge, ops, read, reconcileFor, sessionId, view],
  );
  return { setEnabled, chooseHostPreset, busy };
}

/** The read paths one session has: a guarded read and a mutation's own reads. */
function useReads(options: {
  readonly enabled: boolean;
  readonly sessionId: string | undefined;
  readonly ops: FlowOps;
  readonly barrier: Barrier;
}): {
  readonly read: () => Promise<void>;
  readonly reconcileFor: (ticket: Ticket) => () => Promise<void>;
} {
  const { enabled, sessionId, ops, barrier } = options;

  /**
   * One guarded read of the authoritative answer.
   *
   * `ignoreBarrier` is for a mutation's own reconciliation: that read runs
   * while the barrier is open by construction, and routing it through the
   * barrier would queue a read that never runs and leave the caller waiting on
   * a stale view.
   */
  const readNow = useCallback(
    async (ignoreBarrier: boolean): Promise<void> => {
      if (!enabled || sessionId === undefined) return;
      if (!ignoreBarrier && barrier.writing()) {
        barrier.queue();
        ops.markQueued();
        return;
      }
      const ticket = ops.next();
      ops.markStarted();
      try {
        const answer = await getAdmission(sessionId);
        if (!ops.current(ticket)) return;
        ops.apply(answer);
      } catch (error) {
        ops.markError(ticket, error);
      }
    },
    [barrier, enabled, ops, sessionId],
  );

  /**
   * A mutation's own reads share the mutation's ticket.
   *
   * Taking a fresh ticket per read would invalidate the mutation's own claim,
   * so its final refusal could never be recorded. The mutation owns the newest
   * claim for its whole lifetime; only an unrelated newer request can supersede
   * it, which is exactly the ordering that must win.
   */
  const readNowFor = useCallback(
    async (ticket: Ticket): Promise<void> => {
      if (!enabled || sessionId === undefined) return;
      try {
        const answer = await getAdmission(sessionId);
        if (!ops.current(ticket)) return;
        ops.apply(answer);
      } catch (error) {
        ops.markError(ticket, error);
      }
    },
    [enabled, ops, sessionId],
  );

  const read = useCallback((): Promise<void> => readNow(false), [readNow]);
  return {
    read,
    reconcileFor: (ticket) => async () => {
      await readNowFor(ticket);
    },
  };
}

export function useAdmission(options: {
  readonly sessionId: string | undefined;
  readonly bridge: HostBridge | undefined;
  readonly enabled: boolean;
}): AdmissionController {
  const { sessionId, bridge, enabled } = options;
  const { state, ops } = useFlow(sessionId);
  const { catalog, refresh: refreshCatalog } = useHostCatalog(bridge);
  /** Bumped by every host invalidation, so the host-preset read re-runs. */
  const [hostRevision, setHostRevision] = useState(0);
  /**
   * Barrier flags as refs, not state: the decision whether a read must wait is
   * made inside the same tick as the request, and a rendered state value is one
   * render behind. The state copies exist only for the busy UI.
   */
  const writingRef = useRef(false);
  const queuedRef = useRef(false);

  /** The barrier: a read waits for the write and is then run exactly once. */
  const barrier = useMemo(
    () => ({
      writing: () => writingRef.current,
      opened: () => {
        writingRef.current = true;
        queuedRef.current = false;
      },
      closed: (): boolean => {
        const owed = queuedRef.current;
        writingRef.current = false;
        queuedRef.current = false;
        return owed;
      },
      queue: () => {
        queuedRef.current = true;
      },
      clear: () => {
        queuedRef.current = false;
      },
    }),
    [],
  );

  /**
   * The confirmed view, read through a ref.
   *
   * A write reconciles against the answer it just fetched, and a callback that
   * captured the render's `state` would compare against the pre-write view.
   */
  const viewRef = useRef(state);
  useEffect(() => {
    viewRef.current = state;
  }, [state]);

  const { read, reconcileFor } = useReads({ enabled, sessionId, ops, barrier });

  const { setEnabled, chooseHostPreset } = useAdmissionWrites({
    bridge,
    sessionId,
    ops,
    barrier,
    read,
    reconcileFor,
    view: () => viewRef.current.confirmed,
  });

  // A different session starts from scratch; its predecessor's in-flight answer
  // is fenced out by the ticket's session identity.
  useEffect(() => {
    ops.reset();
    writingRef.current = false;
    queuedRef.current = false;
    if (!enabled || sessionId === undefined) return;
    read().catch(() => undefined);
  }, [enabled, ops, read, sessionId]);

  const onHostSignal = useCallback((): void => {
    setHostRevision((value) => value + 1);
    read().catch(() => undefined);
  }, [read]);
  useBrowserSignals(onHostSignal);

  // Host-side invalidation: a settled /permission command, a projection change,
  // a catalog change, or a reconnect. It only triggers a read.
  useEffect(() => {
    if (bridge === undefined || sessionId === undefined) return;
    return bridge.observe(sessionId, onHostSignal, refreshCatalog);
  }, [bridge, onHostSignal, refreshCatalog, sessionId]);

  const hostPreset = readHostPreset(bridge, sessionId, hostRevision);

  return useMemo(
    () => ({ state, catalog, hostPreset, setEnabled, chooseHostPreset }),
    [catalog, chooseHostPreset, hostPreset, setEnabled, state],
  );
}
