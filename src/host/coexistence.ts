/**
 * The runtime side of approval-provider coexistence.
 *
 * Detection is read-only (`coexistence-detect.ts`); this module owns the state
 * the contract asks for:
 *   - the current assessment, re-read from public surfaces on every relevant
 *     event rather than cached from startup;
 *   - one notice per continuous conflict period, acknowledged separately from
 *     the conflict itself: closing the notice is "read", not "resolved";
 *   - the enable guard, which refuses a new takeover while the official Auto
 *     Review plugin is actually running.
 *
 * Nothing here changes a gate decision. A detected conflict never rewrites the
 * mode, never forces a human approval and never records another provider's
 * denial as this plugin's verdict.
 */

import {
  assess,
  blockReasonOf,
  readObservation,
} from './coexistence-detect.js';
import type {
  AutoSlot,
  CoexistenceAssessment,
  CoexistenceConflict,
  CoexistenceObservation,
} from './coexistence-detect.js';
import type { HostEnvironment } from './types.js';

/** How many settled notices stay addressable. */
const MAX_NOTICES = 20;

/**
 * How often the host observes the plugin inventory without any client.
 *
 * The inventory read is a walk of an in-memory entry list, and this never runs
 * on the tool path, so a short interval is affordable; it is what makes a
 * conflict noticed while no settings page is open.
 */
export const OBSERVE_INTERVAL_MS = 5_000;

export interface CoexistenceNotice {
  readonly id: string;
  readonly conflictId: string;
  readonly severity: 'blocking' | 'warning';
  readonly kind: CoexistenceConflict['kind'];
  readonly source: string;
  readonly capability: string;
  readonly at: number;
  readonly acknowledged: boolean;
  /**
   * Whether the period that produced this notice has already ended.
   *
   * A retired notice is history: it stays readable, but it can never become
   * actionable again if a later period happens to reuse the same conflict id.
   */
  readonly retired?: boolean;
}

/**
 * The Auto-slot capability problem that survives conflict resolution.
 *
 * Clearing the official runtime conflict and proving that this plugin actually
 * holds the Auto entry are two different facts: a registration that already
 * failed does not become successful when the other provider stops. This field
 * keeps that second fact visible instead of reporting "healthy" on the strength
 * of the first.
 */
export type AutoSlotProblem =
  | null
  | {
      readonly kind: 'registration-failed';
      /** The host's own message, when it gave one. */
      readonly error: string | null;
      /** What the user can do; the UI renders it through the locale. */
      readonly recovery: 'reload-plugin';
    }
  | {
      readonly kind: 'slot-unavailable';
      readonly error: null;
      readonly recovery: 'host-unsupported';
    };

export interface CoexistenceView {
  readonly detection: 'complete' | 'partial';
  readonly missing: readonly string[];
  readonly blocked: boolean;
  readonly reason: 'official-running' | null;
  readonly official: CoexistenceAssessment['official'];
  readonly autoSlot: AutoSlot;
  readonly autoSlotProblem: AutoSlotProblem;
  readonly conflicts: readonly CoexistenceConflict[];
  readonly notices: readonly CoexistenceNotice[];
  /** How many times this runtime observed the host on its own. */
  readonly observations: number;
  readonly updatedAt: number;
}

/** The structured detail one blocked admission carries back to the client. */
export interface CoexistenceBlockDetail {
  readonly reason: 'official-running';
  readonly source: string;
  readonly entryId: string | null;
  readonly guidance: 'disable-official-auto-review';
  /** Index signature so the detail is a plain JSON record for the API. */
  readonly [key: string]: unknown;
}

/**
 * What this runtime can currently prove about the official provider.
 *
 * `blocked` is not enough for a decision that outlives one request: a failed
 * read is *not* evidence that a provider stopped, so an established restriction
 * must survive it. These three answers are what the admission paths distinguish.
 */
export type ProviderState = 'running' | 'stopped' | 'unknown';

/** The refusal `enableBlock()` returns; `ok` is added by the admission service. */
export interface CoexistenceBlock {
  readonly code: 'coexistence-blocked';
  readonly message: string;
  readonly detail: CoexistenceBlockDetail;
}

interface MonitorOptions {
  /** Where the Auto slot ended up, as the permission lifecycle observed it. */
  readonly autoSlot: () => AutoSlot;
  /** The registration error the permission lifecycle retained, if any. */
  readonly autoError: () => string | null;
  /** This plugin's own fiber, excluded from the competing-listener set. */
  readonly selfFiber?: unknown;
}

export class CoexistenceMonitor {
  private readonly host: HostEnvironment;
  private readonly options: MonitorOptions;
  private readonly activeConflictIds = new Set<string>();
  private noticeSequence = 0;
  private notices: CoexistenceNotice[] = [];
  private observations = 0;
  /** Whether this runtime has ever observed the official provider running. */
  private everBlocked = false;
  private view: CoexistenceView;

  constructor(host: HostEnvironment, options: MonitorOptions) {
    this.host = host;
    this.options = options;
    this.view = {
      detection: 'partial',
      missing: ['loader', 'events'],
      blocked: false,
      reason: null,
      official: {
        present: false,
        module: '',
        enabled: false,
        running: false,
        phase: null,
      },
      autoSlot: 'unknown',
      autoSlotProblem: null,
      conflicts: [],
      notices: [],
      observations: 0,
      updatedAt: Date.now(),
    };
  }

  /** The current public surface set, read fresh each time. */
  private observe(): CoexistenceObservation {
    return readObservation({
      loader: this.host.ctx.get('loader'),
      events: this.host.ctx.events,
      selfFiber: this.options.selfFiber,
      autoSlot: this.options.autoSlot(),
      autoError: this.options.autoError(),
    });
  }

  /**
   * Recompute the assessment and open one notice per new conflict period.
   *
   * A conflict that disappears ends its period; if it returns later it is a new
   * period and earns a new notice. Staying present never re-notifies.
   */
  refresh(reason: string): CoexistenceView {
    const observation = this.observe();
    const assessment = assess(observation);
    const present = new Set(assessment.conflicts.map((item) => item.id));
    for (const id of present) {
      if (this.activeConflictIds.has(id)) continue;
      this.openNotice(assessment.conflicts.find((item) => item.id === id));
    }
    // An incomplete observation cannot prove a period ended. Only a conflict
    // whose source surface was fully read may be retired; otherwise the same
    // continuous conflict would earn a second reminder when the surface returns.
    const complete = observation.missing.length === 0;
    for (const id of [...this.activeConflictIds]) {
      if (present.has(id)) continue;
      if (!complete && this.dependsOnMissing(id, observation.missing)) continue;
      this.activeConflictIds.delete(id);
      // The period is over: retire its reminder permanently. Marking it
      // acknowledged only in the returned view would let a later period with the
      // same id make the old notice actionable again.
      this.notices = this.notices.map((notice) =>
        notice.conflictId === id && !notice.acknowledged
          ? { ...notice, acknowledged: true, retired: true }
          : notice,
      );
    }
    this.observations += 1;
    // Remember a provider this runtime has actually seen running: only then can
    // a later unreadable surface be `unknown` rather than "nothing to protect".
    if (assessment.blocked || assessment.official.running)
      this.everBlocked = true;
    this.view = {
      detection: assessment.detection,
      missing: assessment.missing,
      blocked: assessment.blocked,
      reason: blockReasonOf(assessment),
      official: assessment.official,
      autoSlot: assessment.autoSlot,
      autoSlotProblem: this.autoSlotProblem(assessment.autoSlot),
      conflicts: assessment.conflicts,
      notices: this.notices,
      observations: this.observations,
      updatedAt: Date.now(),
    };
    this.host.lifecycle('coexistence/refresh', {
      reason,
      detection: assessment.detection,
      blocked: assessment.blocked,
      conflicts: assessment.conflicts.map((item) => item.id),
    });
    return this.view;
  }

  /**
   * The Auto-slot problem that still stands, independent of the official state.
   *
   * `registered` is the only answer that proves this plugin actually took the
   * entry. Losing it to another provider, or a host without the slot, stays an
   * unresolved capability fact even after the official plugin stops — the
   * contract explicitly forbids showing "resolved" from that one signal.
   */
  private autoSlotProblem(slot: AutoSlot): AutoSlotProblem {
    if (slot === 'arbiter') return null;
    const error = this.options.autoError();
    if (slot === 'other') {
      return { kind: 'registration-failed', error, recovery: 'reload-plugin' };
    }
    return {
      kind: 'slot-unavailable',
      error: null,
      recovery: 'host-unsupported',
    };
  }

  /**
   * Observe the host on this runtime's own schedule.
   *
   * A host without a connected page still has to notice a conflict (the
   * contract keeps state and logs for a later reconnect), so the monitor owns a
   * bounded interval instead of waiting for a request. It never touches a gate:
   * a refresh only records a transition and opens notices.
   */
  start(intervalMs = OBSERVE_INTERVAL_MS): () => void {
    this.refresh('startup');
    const timer = setInterval(() => this.refresh('interval'), intervalMs);
    // Never keep the process alive for observation alone. Node's timer always
    // has `unref`; a browser-like stub may not, so the cast is on the method.
    (timer as { unref?: () => void }).unref?.();
    return () => {
      clearInterval(timer);
    };
  }

  /**
   * Whether one conflict's evidence comes from a surface that was unreadable.
   *
   * The Auto-slot conflict is internal, so it is always provable; a hook row and
   * the official row both come from the Loader and event bus respectively.
   */
  private dependsOnMissing(id: string, missing: readonly string[]): boolean {
    if (id === 'auto-slot') return false;
    if (id === 'official-auto-review') return missing.includes('loader');
    return missing.includes('events');
  }

  /** Record one notice, bounded and with a stable per-period identity. */
  private openNotice(conflict: CoexistenceConflict | undefined): void {
    if (conflict === undefined) return;
    this.activeConflictIds.add(conflict.id);
    this.noticeSequence += 1;
    const notice: CoexistenceNotice = {
      id: `coexistence-${String(this.noticeSequence)}`,
      conflictId: conflict.id,
      severity: conflict.severity,
      kind: conflict.kind,
      source: conflict.source,
      capability: conflict.capability,
      at: Date.now(),
      acknowledged: false,
    };
    this.notices = [...this.notices, notice].slice(-MAX_NOTICES);
    this.host.ctx.logger.warn(
      'arbiter: coexisting approval provider detected (%s: %s, %s); arbitration stays as configured',
      conflict.severity,
      conflict.source,
      conflict.capability,
    );
    this.host.lifecycle('coexistence/notice', {
      noticeId: notice.id,
      conflictId: notice.conflictId,
      severity: notice.severity,
      source: notice.source,
    });
  }

  /** The view the API reports; a read refreshes, so a reconnect is current. */
  read(reason = 'read'): CoexistenceView {
    return this.refresh(reason);
  }

  /**
   * Mark notices as read.
   *
   * Acknowledgement never clears `conflicts` or `blocked`: the notice is user
   * feedback, not a resolution step. Unknown ids are ignored.
   */
  acknowledge(ids: readonly string[]): CoexistenceView {
    const wanted = new Set(ids);
    this.notices = this.notices.map((notice) =>
      wanted.has(notice.id) ? { ...notice, acknowledged: true } : notice,
    );
    this.view = { ...this.view, notices: this.notices };
    this.host.lifecycle('coexistence/acknowledged', {
      ids: [...wanted],
    });
    return this.refresh('acknowledge');
  }

  /**
   * The refusal `enable` must return, or null when a takeover may proceed.
   *
   * Reading first is the point: a provider can start running after this
   * plugin's startup, and a cached "no conflict" would let the takeover widen a
   * session under a second reviewer. Nothing is written by this call.
   */
  /**
   * The tri-state provider answer, re-read from the host.
   *
   * `unknown` means a public surface needed to see the provider could not be
   * read. It must never be treated as `stopped`: the contract says a disk switch
   * cannot prove a provider stopped, and neither can a failed read.
   */
  providerState(): ProviderState {
    const view = this.refresh('provider-state');
    if (view.blocked || view.official.running) return 'running';
    // The official provider is a Loader entry, so only the Loader's own
    // completeness can establish that it stopped. An unreadable *listener*
    // registry degrades warning detection, but says nothing about the provider.
    if (!view.missing.includes('loader')) return 'stopped';
    // An unreadable surface is only *unknown* about a provider this runtime has
    // actually seen. On a host that never exposed that surface there is no
    // established restriction for `unknown` to protect, and refusing every
    // activation there would block a deployment the detector simply cannot
    // inspect (the reader reports the limitation separately).
    return this.everBlocked ? 'unknown' : 'stopped';
  }

  enableBlock(): CoexistenceBlock | null {
    const view = this.refresh('enable');
    if (!view.blocked) return null;
    const conflict = view.conflicts.find(
      (item) => item.severity === 'blocking',
    );
    return {
      code: 'coexistence-blocked',
      message:
        'the official Auto Review plugin is running; arbiter does not take over a session while another approval provider is active',
      detail: {
        reason: 'official-running',
        source: conflict?.source ?? view.official.module,
        entryId: conflict?.entryId ?? null,
        guidance: 'disable-official-auto-review',
      },
    };
  }

  /** One bounded summary for the state payload and the API. */
  summary(): CoexistenceView {
    return this.read('state');
  }
}
