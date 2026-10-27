import type { ReactNode } from 'react';

import { Button, Notice } from './controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import type { Translate } from '../i18n.js';
import type {
  CoexistenceConflictView,
  CoexistenceNoticeView,
  CoexistenceView,
} from '../view-types.js';

/**
 * Why one conflict blocks or warns, in the user's language.
 *
 * The host reports a stable kind and capability; the sentence belongs to the
 * locale. Nothing here invents a source list: an unrecognized kind falls back to
 * the generic sentence plus the raw capability the host observed.
 */
function reasonText(t: Translate, conflict: CoexistenceConflictView): string {
  if (conflict.kind === 'official-auto-review')
    return t('coexistence.reason.officialRunning', {
      source: conflict.source,
    });
  if (conflict.kind === 'auto-slot')
    return t('coexistence.reason.autoSlotTaken', {
      source: conflict.source,
      error: conflict.detail ?? '',
    });
  return t('coexistence.reason.approvalHook', {
    source: conflict.source,
    capability: conflict.capability,
  });
}

function severityText(t: Translate, severity: 'blocking' | 'warning'): string {
  return severity === 'blocking'
    ? t('coexistence.severity.blocking')
    : t('coexistence.severity.warning');
}

function ConflictRow({
  conflict,
}: {
  readonly conflict: CoexistenceConflictView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <li>
      <strong>{severityText(t, conflict.severity)}</strong>{' '}
      {reasonText(t, conflict)}
      {conflict.entryId === null ? null : (
        <span
          style={{ color: 'var(--dsw-alias-label-tertiary)', fontSize: 11.5 }}
        >
          {' '}
          {t('coexistence.entry', { entry: conflict.entryId })}
        </span>
      )}
    </li>
  );
}

/**
 * The persistent conflict section.
 *
 * It renders the unresolved state, not the notices: dismissing a reminder never
 * removes a row here, because acknowledgement is "read", not "resolved".
 */
function slotText(t: Translate, slot: CoexistenceView['autoSlot']): string {
  if (slot === 'arbiter') return t('coexistence.slot.arbiter');
  if (slot === 'other') return t('coexistence.slot.other');
  return t('coexistence.slot.unknown');
}

function officialStateText(
  t: Translate,
  official: CoexistenceView['official'],
): string {
  const state = official.running
    ? t('coexistence.official.running')
    : official.present
      ? t('coexistence.official.stopped')
      : t('coexistence.official.absent');
  return t('coexistence.officialState', {
    state,
    phase: official.phase ?? t('coexistence.official.noPhase'),
  });
}

function detectionText(t: Translate, coexistence: CoexistenceView): string {
  return coexistence.detection === 'complete'
    ? t('coexistence.detection.complete')
    : t('coexistence.detection.partial', {
        surfaces: coexistence.missing.join(', '),
      });
}

function autoSlotProblemText(
  t: Translate,
  coexistence: CoexistenceView,
): string | null {
  const problem = coexistence.autoSlotProblem;
  if (problem === null) return null;
  return problem.kind === 'slot-unavailable'
    ? t('coexistence.autoSlotProblem.unavailable')
    : t('coexistence.autoSlotProblem.failed', { error: problem.error ?? '' });
}

export function CoexistenceSection({
  coexistence,
}: {
  readonly coexistence: CoexistenceView | null;
}): ReactNode {
  const t = useArbiterTranslation();
  if (coexistence === null) return null;
  const blocking = coexistence.conflicts.filter(
    (conflict) => conflict.severity === 'blocking',
  );
  const warnings = coexistence.conflicts.filter(
    (conflict) => conflict.severity === 'warning',
  );
  const slotProblem = autoSlotProblemText(t, coexistence);
  return (
    <section
      data-arbiter-coexistence
      className="arb:mb-6 arb:flex arb:flex-col arb:gap-2"
    >
      <div>
        <h3 className="arb:m-0 arb:text-[15px] arb:font-semibold">
          {t('coexistence.title')}
        </h3>
        <p className="arb:mt-1 arb:text-[12.5px] arb:text-secondary">
          {t('coexistence.description')}
        </p>
      </div>
      <div className="arb:text-[12.5px] arb:leading-relaxed">
        <div>{officialStateText(t, coexistence.official)}</div>
        <div>
          {t('coexistence.autoSlotState', {
            slot: slotText(t, coexistence.autoSlot),
          })}
        </div>
        <div>{detectionText(t, coexistence)}</div>
      </div>
      {coexistence.conflicts.length === 0 ? (
        <Notice kind="ok" text={t('coexistence.none')} />
      ) : (
        <ul className="arb:m-0 arb:pl-5 arb:text-[12.5px]">
          {[...blocking, ...warnings].map((conflict) => (
            <ConflictRow key={conflict.id} conflict={conflict} />
          ))}
        </ul>
      )}
      {coexistence.blocked ? (
        <Notice
          kind="error"
          text={t('coexistence.blockedGuidance', {
            source: blocking[0]?.source ?? coexistence.official.module,
          })}
        />
      ) : null}
      {slotProblem === null ? null : <Notice kind="info" text={slotProblem} />}
      {warnings.length === 0 ? null : (
        <Notice kind="info" text={t('coexistence.warningGuidance')} />
      )}
    </section>
  );
}

/**
 * The one-time conflict reminder.
 *
 * A blocking conflict opens a dialog with the exact reason and the way out; the
 * other conflicts use a lightweight notice. Both are dismissed for this
 * conflict period only — the persistent section keeps showing the state, and a
 * new conflict period earns a new reminder.
 */
export function CoexistenceAlert({
  coexistence,
  onAcknowledge,
  onOpenPluginManager,
}: {
  readonly coexistence: CoexistenceView | null;
  readonly onAcknowledge: (ids: readonly string[]) => void;
  /** Opens the host's own plugin panel; absent when the host exposes none. */
  readonly onOpenPluginManager?: (() => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  if (coexistence === null) return null;
  // A retired notice belongs to a period that already ended, so it can never
  // become actionable again even if a later period reuses the conflict id.
  const pending = coexistence.notices.filter(
    (notice) => !notice.acknowledged && notice.retired !== true,
  );
  if (pending.length === 0) return null;
  const blocking = pending.find((notice) => notice.severity === 'blocking');
  if (blocking !== undefined)
    return (
      <BlockingAlert
        notice={blocking}
        coexistence={coexistence}
        onAcknowledge={onAcknowledge}
        onOpenPluginManager={onOpenPluginManager}
      />
    );
  return (
    <div
      data-arbiter-coexistence-notice
      data-arbiter-surface="coexistence-overlay"
      role="status"
      className="arb:fixed arb:right-6 arb:bottom-6 arb:z-40 arb:flex arb:max-w-[420px] arb:flex-col arb:gap-2 arb:rounded-lg arb:border arb:border-border-default arb:bg-layer-3 arb:p-3 arb:text-[12.5px] arb:shadow-lg"
    >
      <strong>{t('coexistence.notice.warningTitle')}</strong>
      {pending.map((notice) => (
        <span key={notice.id}>
          {t('coexistence.notice.warningBody', {
            source: notice.source,
            capability: notice.capability,
          })}
        </span>
      ))}
      <div className="arb:flex arb:justify-end">
        <Button
          onClick={() => {
            onAcknowledge(pending.map((notice) => notice.id));
          }}
        >
          {t('coexistence.notice.dismiss')}
        </Button>
      </div>
    </div>
  );
}

function BlockingAlert({
  notice,
  coexistence,
  onAcknowledge,
  onOpenPluginManager,
}: {
  readonly notice: CoexistenceNoticeView;
  readonly coexistence: CoexistenceView;
  readonly onAcknowledge: (ids: readonly string[]) => void;
  readonly onOpenPluginManager?: (() => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    // A reminder, not a gate: this is a corner card rather than a full-screen
    // scrim, because covering the page would stop the user from continuing the
    // work the contract says must not wait for an answer.
    <div
      role="alertdialog"
      aria-label={t('coexistence.notice.blockingTitle')}
      data-arbiter-coexistence-alert
      data-arbiter-surface="coexistence-overlay"
      style={{
        position: 'fixed',
        right: '24px',
        bottom: '24px',
      }}
      className="arb:fixed arb:right-6 arb:bottom-6 arb:z-50 arb:flex arb:max-w-[560px] arb:flex-col arb:gap-3 arb:rounded-xl arb:border arb:border-border-default arb:bg-layer-1 arb:p-5 arb:text-[13px] arb:leading-relaxed arb:shadow-2xl"
    >
      <h3 className="arb:m-0 arb:text-base arb:font-semibold">
        {t('coexistence.notice.blockingTitle')}
      </h3>
      <p className="arb:m-0">
        {t('coexistence.notice.blockingBody', { source: notice.source })}
      </p>
      <p className="arb:m-0">{t('coexistence.notice.blockingGuidance')}</p>
      {coexistence.official.present ? null : (
        <p className="arb:m-0">{t('coexistence.notice.detectionOnly')}</p>
      )}
      <div className="arb:flex arb:justify-end arb:gap-2">
        {onOpenPluginManager === undefined ? null : (
          <Button
            onClick={() => {
              // Opening the manager is a navigation action, not an
              // acknowledgement: the conflict stays visible until it is
              // actually gone.
              onOpenPluginManager();
            }}
          >
            {t('coexistence.notice.openManager')}
          </Button>
        )}
        <Button
          tone="primary"
          onClick={() => {
            onAcknowledge([notice.id]);
          }}
        >
          {t('coexistence.notice.acknowledge')}
        </Button>
      </div>
    </div>
  );
}
