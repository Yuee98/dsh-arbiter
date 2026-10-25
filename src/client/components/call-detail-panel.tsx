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
import { Button, Notice } from './controls.js';
import { useCallDetail } from './use-call-detail.js';
import type { CallDetailState } from '../view-types.js';

/** The absent or failed states, each with its own sentence. */
function AbsentState({
  state,
  onRetry,
}: {
  readonly state: CallDetailState;
  readonly onRetry: () => void;
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
          <Notice kind="error" text={state.message} />
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
      <AbsentState state={state} onRetry={reload} />
    </div>
  );
}
