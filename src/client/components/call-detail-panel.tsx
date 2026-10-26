/**
 * The shared open entry for one call detail.
 *
 * Both the log list and — from #19 — a session tool-call entry open a detail by
 * `callId` through this component, so there is exactly one request, one set of
 * absence states and one rendered view. The panel owns the load; the detail
 * itself is {@link CallDetail}, and a caller that already holds a decoded record
 * can render that directly.
 */

import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { CallDetail } from './call-detail.js';
import { Button, Notice, Section } from './controls.js';
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
}: {
  readonly state: CallDetailState;
  readonly onRetry: () => void;
  readonly fallback: CallDetailFallback | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  switch (state.kind) {
    case 'loading':
      return (
        <p style={{ margin: 0, fontSize: 12.5 }}>{t('callDetail.loading')}</p>
      );
    case 'ready':
      return <CallDetail detail={state.detail} />;
    case 'record-unavailable':
      return (
        <div data-call-detail-state="record-unavailable">
          <Notice kind="info" text={t('callDetail.recordUnavailable')} />
          {fallback === undefined ? null : (
            <div data-call-detail-fallback={fallback.tool}>
              <Section
                title={t('callDetail.minimalVerdict')}
                description={t('callDetail.minimalVerdictHint')}
              >
                <p style={{ margin: 0, fontSize: 12.5 }}>
                  {`${fallback.sourceLabel} · ${fallback.tool}`}
                </p>
                <p style={{ margin: 0, fontSize: 12.5 }}>{fallback.reason}</p>
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
        <div data-call-detail-state="failed">
          <Notice
            kind="error"
            text={`${t('callDetail.loadFailed')} ${state.message}`}
          />
          <Button onClick={onRetry}>{t('callDetail.retry')}</Button>
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
  /**
   * The caller's own recorded facts, shown only when no source holds the call.
   *
   * A session entry passes these so a denial that never produced an audit or
   * decision record still explains its verdict; the log list omits them.
   */
  readonly fallback?: CallDetailFallback;
}): ReactNode {
  const t = useArbiterTranslation();
  const { state, reload } = useCallDetail(props.callId);
  // No wrapper heading: the detail renders its own title, so a caller cannot
  // end up with two different names for the same view.
  return (
    <div
      data-call-detail-panel={props.callId}
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      {props.onClose === undefined ? null : (
        <div>
          <Button onClick={props.onClose}>{t('callDetail.close')}</Button>
        </div>
      )}
      <AbsentState state={state} onRetry={reload} fallback={props.fallback} />
    </div>
  );
}
