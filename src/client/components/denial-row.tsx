/**
 * One Arbiter denial, shown where the call it refused sits in the session.
 *
 * This row is the plugin's own Chat row: the host's tool-call card belongs to
 * `dsh-client-ui-tool`, whose only per-call extension point is the keyed
 * `tool.call.toolview` slot that replaces a whole tool's view. Registering there
 * would have taken over every `bash`/`read`/`edit` card, so Arbiter adds the
 * actionable refusal beside that call instead, keyed to the same `callId`.
 *
 * What it must not do is just as load-bearing: it never announces itself with a
 * toast or modal, and the detail it opens is #17's shared {@link CallDetailPanel}
 * — the same request, states and view the log list uses.
 */

import type { ReactNode } from 'react';
import { useId, useRef, useState } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import type { ArbiterDenialSource, ArbiterDenialView } from '../view-types.js';
import { CallDetailPanel } from './call-detail-panel.js';
import { Button } from './controls.js';
import { Badge } from './ui/badge.js';

/**
 * The one-line sentence naming which stage refused.
 *
 * A rule, a review, an unavailable channel, a person's refusal and an abandoned
 * question are different facts, so each gets its own sentence; only `human` says
 * the user rejected the call. `unattributed` says the record did not state a
 * stage rather than picking one.
 */
const SOURCE_KEYS: Readonly<Record<ArbiterDenialSource, string>> = {
  rule: 'denials.source.rule',
  review: 'denials.source.review',
  fallback: 'denials.source.fallback',
  human: 'denials.source.human',
  abort: 'denials.source.abort',
  boundary: 'denials.source.boundary',
  unattributed: 'denials.source.unattributed',
};

/** One-line label for the detail entry; the panel itself owns the title. */
const DETAIL_OPEN_KEY = 'denials.action.detail';
const DETAIL_CLOSE_KEY = 'denials.action.closeDetail';

/**
 * Render one denial marker with its reason and the shared detail entry.
 *
 * The marker is announced as a `status` so a screen reader reads the refusal
 * once when it lands, without stealing focus from the composer.
 */
export function DenialRow(props: {
  readonly callId: string;
  readonly tool: string;
  readonly denial: ArbiterDenialView;
}): ReactNode {
  const t = useArbiterTranslation();
  const regionId = `${useId()}-detail`;
  const [open, setOpen] = useState(false);
  const openerRef = useRef<HTMLButtonElement | null>(null);
  const reason = props.denial.reason;
  return (
    <div
      data-arbiter-row={props.callId}
      data-arbiter-surface="denial-row"
      className="arb:my-1 arb:flex arb:min-h-8 arb:self-stretch arb:flex-col arb:gap-1.5 arb:rounded-sm arb:border-l-[3px] arb:border-warning arb:bg-warning/10 arb:px-2.5 arb:py-1.5 arb:text-[12.5px]"
    >
      <div
        role="status"
        data-arbiter-denial={props.denial.source}
        data-call-id={props.callId}
        className="arb:flex arb:flex-col arb:gap-1"
      >
        <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-1.5">
          <span aria-hidden="true" className="arb:text-xs arb:text-warning">
            ●
          </span>
          <Badge tone="warning">{t('denials.badge')}</Badge>
          <span
            data-denial-source={props.denial.source}
            className="arb:text-secondary"
          >
            <span>{t('denials.sourceLabel')}</span>
            <span aria-hidden="true">{' · '}</span>
            <span>{t(SOURCE_KEYS[props.denial.source])}</span>
          </span>
          <span className="arb:text-secondary">{props.tool}</span>
        </div>
        <div className="arb:flex arb:items-baseline arb:gap-2">
          <span className="arb:min-w-0 arb:break-words">
            {reason ?? t('denials.reasonMissing')}
          </span>
          {props.denial.truncated ? (
            <span
              data-denial-truncated="true"
              className="arb:whitespace-nowrap arb:text-[11.5px] arb:text-tertiary"
            >
              {t('denials.truncated')}
            </span>
          ) : null}
        </div>
      </div>
      <div>
        <Button
          ref={openerRef}
          onClick={() => {
            setOpen((current) => !current);
          }}
        >
          {open ? t(DETAIL_CLOSE_KEY) : t(DETAIL_OPEN_KEY)}
        </Button>
      </div>
      {open ? (
        <div id={regionId} className="arb:pt-1">
          <CallDetailPanel
            callId={props.callId}
            openerRef={openerRef}
            onClose={() => {
              setOpen(false);
            }}
            // The row already holds this call's recorded tool and reason. When
            // the audit store and the decision history both lack the call (a
            // boundary refusal or a teardown fallback never writes one), the
            // panel shows these as the minimal verdict rather than only saying
            // the record is gone.
            fallback={{
              tool: props.tool,
              sourceLabel: t('denials.minimalSource'),
              reason: props.denial.fullReason ?? t('denials.reasonMissing'),
            }}
          />
        </div>
      ) : null}
    </div>
  );
}
