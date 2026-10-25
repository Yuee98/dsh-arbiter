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

export interface CoexistenceNotice {
  readonly id: string;
  readonly conflictId: string;
  readonly severity: 'blocking' | 'warning';
  readonly kind: CoexistenceConflict['kind'];
  readonly source: string;
  readonly capability: string;
  readonly at: number;
  readonly acknowledged: boolean;
}

export interface CoexistenceView {
  readonly detection: 'complete' | 'partial';
  readonly missing: readonly string[];
  readonly blocked: boolean;
  readonly reason: 'official-running' | null;
  readonly official: CoexistenceAssessment['official'];
  readonly autoSlot: AutoSlot;
  readonly conflicts: readonly CoexistenceConflict[];
  readonly notices: readonly CoexistenceNotice[];
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
      conflicts: [],
      notices: [],
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
    const assessment = assess(this.observe());
    const present = new Set(assessment.conflicts.map((item) => item.id));
    for (const id of present) {
      if (this.activeConflictIds.has(id)) continue;
      this.openNotice(assessment.conflicts.find((item) => item.id === id));
    }
    for (const id of [...this.activeConflictIds]) {
      if (!present.has(id)) this.activeConflictIds.delete(id);
    }
    this.view = {
      detection: assessment.detection,
      missing: assessment.missing,
      blocked: assessment.blocked,
      reason: blockReasonOf(assessment),
      official: assessment.official,
      autoSlot: assessment.autoSlot,
      conflicts: assessment.conflicts,
      notices: this.notices,
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
