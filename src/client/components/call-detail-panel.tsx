/**
 * The shared open entry for one call detail.
 *
 * Both the log list and — from #19 — a session tool-call entry open a detail by
 * `callId` through this component, so there is exactly one request, one set of
 * absence states and one rendered view. The panel owns the load; the detail
 * itself is {@link CallDetail}, and a caller that already holds a decoded record
 * can render that directly.
 */

import { useRef, type ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { CallDetail } from './call-detail.js';
import { Button, Notice, Section } from './controls.js';
import type { RuleCallSource } from './rules/rule-from-call-model.js';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from './ui/dialog.js';
import { useCallDetail } from './use-call-detail.js';
import type { CallDetailState } from '../view-types.js';

/**
 * The facts a caller already holds for a call no source can locate.
 *
 * A session row knows the call it is about: the id, the tool and the reason the
 * decision recorded. When the audit store and the runtime history both lack the
 * call — a boundary refusal or a teardown fallback never writes a decision
 * record — that knowledge is still true, so the panel shows it as the minimal
 * verdict instead of only saying the record is gone. It is explicitly labelled
 * as the session record and fabricates no stage chain or materials.
 */
export interface CallDetailFallback {
  readonly tool: string;
  readonly sourceLabel: string;
  readonly reason: string;
}

/** The absent or failed states, each with its own sentence. */
function AbsentState({
  state,
  onRetry,
  fallback,
  onCreateRule,
}: {
  readonly state: CallDetailState;
  readonly onRetry: () => void;
  readonly fallback: CallDetailFallback | undefined;
  readonly onCreateRule: ((source: RuleCallSource) => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  switch (state.kind) {
    case 'loading':
      return (
        <p className="arb:m-0 arb:text-xs arb:text-secondary">
          {t('callDetail.loading')}
        </p>
      );
    case 'ready':
      return (
        <CallDetail
          detail={state.detail}
          {...(onCreateRule === undefined ? {} : { onCreateRule })}
        />
      );
    case 'record-unavailable':
      return (
        <div
          data-call-detail-state="record-unavailable"
          className="arb:flex arb:flex-col arb:gap-3"
        >
          <Notice kind="info" text={t('callDetail.recordUnavailable')} />
          {fallback === undefined ? null : (
            <div data-call-detail-fallback={fallback.tool}>
              <Section
                title={t('callDetail.minimalVerdict')}
                description={t('callDetail.minimalVerdictHint')}
              >
                <p className="arb:m-0 arb:text-xs arb:font-medium arb:text-primary">
                  {`${fallback.sourceLabel} · ${fallback.tool}`}
                </p>
                <p className="arb:m-0 arb:text-xs arb:text-secondary">
                  {fallback.reason}
                </p>
              </Section>
            </div>
          )}
        </div>
      );
    case 'audit-unavailable':
      return (
        <div data-call-detail-state="audit-unavailable">
          <Notice kind="info" text={t('callDetail.auditUnavailable')} />
        </div>
      );
    case 'failed':
      return (
        <div
          data-call-detail-state="failed"
          className="arb:flex arb:flex-col arb:gap-3"
        >
          <Notice
            kind="error"
            text={`${t('callDetail.loadFailed')} ${state.message}`}
          />
          <div>
            <Button onClick={onRetry}>{t('callDetail.retry')}</Button>
          </div>
        </div>
      );
  }
}

/**
 * Open one call by id.
 *
 * `onClose` is optional so a session entry can keep the detail inline while the
 * log list offers an explicit close.
 */
export function CallDetailPanel(props: {
  readonly callId: string;
  readonly onClose?: () => void;
  readonly openerRef?: React.RefObject<HTMLElement | null> | undefined;
  /**
   * The caller's own recorded facts, shown only when no source holds the call.
   *
   * A session entry passes these so a denial that never produced an audit or
   * decision record still explains its verdict; the log list omits them.
   */
  readonly fallback?: CallDetailFallback;
  /** Where a rule draft from this call goes, when the caller has a rules surface. */
  readonly onCreateRule?: ((source: RuleCallSource) => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  const { state, reload } = useCallDetail(props.callId);
  const openerRef = useRef<HTMLElement | null>(null);

  return (
    <Dialog
      open={true}
      onOpenChange={(open) => {
        if (!open) props.onClose?.();
      }}
    >
      <DialogContent
        data-call-detail-panel={props.callId}
        data-arbiter-surface="call-detail-dialog"
        showCloseButton={true}
        closeLabel={t('callDetail.close')}
        onCloseAutoFocus={(event) => {
          event.preventDefault();
          const opener = props.openerRef?.current ?? openerRef.current;
          if (opener !== null && document.contains(opener)) {
            opener.focus();
          } else {
            const fallback =
              document.querySelector<HTMLElement>(
                '[data-arbiter-surface="logs-panel"] button, [data-arbiter-surface="denials-panel"] button, [data-arbiter-root] button, button',
              ) ?? null;
            fallback?.focus();
          }
        }}
        className="arb:flex arb:max-h-[85vh] arb:max-w-3xl arb:flex-col arb:gap-4 arb:overflow-y-auto"
      >
        <DialogHeader className="arb:border-b arb:border-border-default arb:pb-3 arb:pr-8">
          <DialogTitle className="arb:text-base arb:font-semibold arb:text-primary">
            {t('callDetail.title', { callId: props.callId })}
          </DialogTitle>
          <DialogDescription className="arb:sr-only">
            {t('callDetail.dialogDescription')}
          </DialogDescription>
        </DialogHeader>
        <AbsentState
          state={state}
          onRetry={reload}
          fallback={props.fallback}
          onCreateRule={props.onCreateRule}
        />
      </DialogContent>
    </Dialog>
  );
}
