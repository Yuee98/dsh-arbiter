import type {
  AutoSlotProblemView,
  CoexistenceConflictView,
  CoexistenceNoticeView,
  CoexistenceView,
} from '../view-types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  optional,
  text,
} from './values.js';

const conflict = (value: unknown): CoexistenceConflictView => {
  const source = object(value);
  return {
    id: field(source, 'id', text),
    severity: field(source, 'severity', choice('blocking', 'warning')),
    kind: field(
      source,
      'kind',
      choice('official-auto-review', 'auto-slot', 'approval-hook'),
    ),
    source: field(source, 'source', text),
    entryId: field(source, 'entryId', nullable(text)),
    capability: field(source, 'capability', text),
    detail: field(source, 'detail', nullable(text)),
  };
};

const notice = (value: unknown): CoexistenceNoticeView => {
  const source = object(value);
  return {
    id: field(source, 'id', text),
    conflictId: field(source, 'conflictId', text),
    severity: field(source, 'severity', choice('blocking', 'warning')),
    kind: field(
      source,
      'kind',
      choice('official-auto-review', 'auto-slot', 'approval-hook'),
    ),
    source: field(source, 'source', text),
    capability: field(source, 'capability', text),
    at: field(source, 'at', number),
    acknowledged: field(source, 'acknowledged', boolean),
  };
};

const autoSlotProblem = (value: unknown): AutoSlotProblemView => {
  if (value === null || value === undefined) return null;
  const source = object(value);
  const kind = field(
    source,
    'kind',
    choice('registration-failed', 'slot-unavailable'),
  );
  if (kind === 'slot-unavailable')
    return { kind, error: null, recovery: 'host-unsupported' };
  return {
    kind,
    error: field(source, 'error', nullable(text)),
    recovery: field(source, 'recovery', choice('reload-plugin')),
  };
};

/**
 * Decode one coexistence view.
 *
 * A missing value yields `null` instead of throwing: a host from before this
 * feature, or a state payload with no coexistence section, must render as "not
 * reported" rather than breaking the whole page.
 */
export function coexistenceView(value: unknown): CoexistenceView | null {
  if (value === null || value === undefined) return null;
  const source = object(value);
  const official = field(source, 'official', object);
  return {
    detection: field(source, 'detection', choice('complete', 'partial')),
    missing: field(source, 'missing', array(text)),
    blocked: field(source, 'blocked', boolean),
    reason: field(source, 'reason', nullable(choice('official-running'))),
    official: {
      present: field(official, 'present', boolean),
      module: field(official, 'module', text),
      enabled: field(official, 'enabled', boolean),
      running: field(official, 'running', boolean),
      phase: field(official, 'phase', nullable(text)),
    },
    autoSlot: field(source, 'autoSlot', choice('arbiter', 'other', 'unknown')),
    autoSlotProblem:
      field(source, 'autoSlotProblem', optional(autoSlotProblem)) ?? null,
    conflicts: field(source, 'conflicts', array(conflict)),
    notices: field(source, 'notices', array(notice)),
    observations: field(source, 'observations', optional(number)) ?? 0,
    updatedAt: field(source, 'updatedAt', number),
  };
}

/** The coexistence route's answer. */
export function coexistenceResponse(value: unknown): {
  readonly ok: boolean;
  readonly coexistence: CoexistenceView | null;
} {
  const source = object(value);
  return {
    ok: field(source, 'ok', boolean),
    coexistence:
      field(source, 'coexistence', optional(coexistenceView)) ?? null,
  };
}
