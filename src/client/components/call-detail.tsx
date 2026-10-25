/**
 * The shared call detail: the one view a session entry and the log list open.
 *
 * The layer order is fixed by the design: the overview answers "what was decided
 * and why", the basis answers "on what grounds", and the raw materials are
 * collapsed until someone needs to inspect them. The two facts that must never
 * be conflated are kept in separate blocks and separate sentences:
 *
 *   - the permission verdict is this plugin's decision;
 *   - the execution status is what the host observed afterwards.
 *
 * A partial (session-sourced) detail renders the same layers with the absent
 * ones reported as missing, so the shape of the view does not change with the
 * source — only the evidence does.
 */

import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { CallDetailBasis } from './call-detail-basis.js';
import {
  executionLabel,
  missingLabel,
  verdictLabel,
} from './call-detail-labels.js';
import { CallDetailRaw } from './call-detail-raw.js';
import { JsonBlock, Notice, Section } from './controls.js';
import { formatTime } from '../view-helpers.js';
import type { CallDetailView } from '../view-types.js';

/** One label/value row of the overview table. */
function Fact(props: {
  readonly label: string;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <tr data-call-detail-fact={props.label}>
      <th
        scope="row"
        style={{
          padding: '3px 12px 3px 0',
          textAlign: 'left',
          fontWeight: 400,
          verticalAlign: 'top',
          color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'nowrap',
        }}
      >
        {props.label}
      </th>
      <td style={{ padding: '3px 0' }}>{props.children}</td>
    </tr>
  );
}

/** The verdict and its reason, shown before every other overview fact. */
function FinalVerdict({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { verdict, verdictReason, cancelled } = detail.overview;
  return (
    <section
      aria-label={t('callDetail.finalVerdict')}
      data-call-detail-verdict
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        padding: '8px 10px',
        borderRadius: 6,
        background: 'var(--dsw-alias-bg-module-platform)',
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
        <span
          style={{ fontSize: 12.5, color: 'var(--dsw-alias-label-secondary)' }}
        >
          {t('callDetail.finalVerdict')}
        </span>
        <strong style={{ fontSize: 14 }}>
          {verdict === null
            ? t('callDetail.verdictUnknown')
            : verdictLabel(t, verdict)}
        </strong>
        {cancelled ? (
          <span
            style={{ fontSize: 12, color: 'var(--dsw-alias-label-secondary)' }}
          >
            {t('callDetail.cancelled')}
          </span>
        ) : null}
      </div>
      <div style={{ fontSize: 12.5, whiteSpace: 'pre-wrap' }}>
        {verdictReason === null ? t('callDetail.reasonMissing') : verdictReason}
      </div>
    </section>
  );
}

/** One execution observation, worded so it cannot read as a permission verdict. */
function ExecutionResult({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const { execution } = detail.overview;
  if (execution.status === null)
    return <span>{t('callDetail.executionNotObserved')}</span>;
  return (
    <div data-call-detail-execution>
      <div>{executionLabel(t, execution.status)}</div>
      <div style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('callDetail.executionNote')}
      </div>
      {execution.startedAt === null ? null : (
        <div style={{ fontSize: 11.5 }}>
          {t('callDetail.executionStarted', {
            time: formatTime(execution.startedAt),
          })}
        </div>
      )}
      {execution.finishedAt === null ? null : (
        <div style={{ fontSize: 11.5 }}>
          {t('callDetail.executionFinished', {
            time: formatTime(execution.finishedAt),
          })}
        </div>
      )}
    </div>
  );
}

/** Everything the view knows is missing, as sentences. */
export function MissingNotices({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  const labels = detail.missing.flatMap((code) => {
    const label = missingLabel(t, code);
    return label === null ? [] : [label];
  });
  if (labels.length === 0 && detail.missingUnknown === 0) return null;
  const lines = [
    ...labels,
    ...(detail.missingUnknown === 0
      ? []
      : [t('callDetail.missingUnknown', { count: detail.missingUnknown })]),
  ];
  return (
    <div
      data-call-detail-missing
      role="group"
      aria-label={t('callDetail.missingTitle')}
    >
      <Notice kind="info" text={lines.join('\n')} />
    </div>
  );
}

/** The overview layer: the call, its final verdict and its execution result. */
function Overview({ detail }: { readonly detail: CallDetailView }): ReactNode {
  const t = useArbiterTranslation();
  const { overview } = detail;
  return (
    <div
      role="group"
      aria-label={t('callDetail.overview')}
      style={{ display: 'flex', flexDirection: 'column', gap: 10 }}
    >
      <FinalVerdict detail={detail} />
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          <Fact label={t('callDetail.tool')}>{overview.tool}</Fact>
          <Fact label={t('callDetail.time')}>{formatTime(overview.ts)}</Fact>
          <Fact label={t('callDetail.approvalMode')}>
            {overview.approvalMode ?? t('callDetail.unknown')}
          </Fact>
          <Fact label={t('callDetail.executionMode')}>
            {overview.executionMode ?? t('callDetail.unknown')}
          </Fact>
          <Fact label={t('callDetail.execution')}>
            <ExecutionResult detail={detail} />
          </Fact>
          <Fact label={t('callDetail.session')}>
            {overview.sessionId === null
              ? t('callDetail.unknown')
              : t('callDetail.sessionValue', {
                  id: overview.sessionId,
                  kind: overview.sessionKind ?? t('callDetail.unknown'),
                })}
          </Fact>
          {overview.parentSession === null ? null : (
            <Fact label={t('callDetail.parentSession')}>
              {overview.parentSession}
            </Fact>
          )}
          <Fact label={t('callDetail.configRevision')}>
            <code>{overview.configRevision ?? t('callDetail.unknown')}</code>
          </Fact>
          <Fact label={t('callDetail.fingerprint')}>
            <code>{overview.fingerprint ?? t('callDetail.unknown')}</code>
          </Fact>
          <Fact label={t('callDetail.workspace')}>
            {overview.cwd ?? overview.workspace ?? t('callDetail.unknown')}
          </Fact>
        </tbody>
      </table>
    </div>
  );
}

/** Where a partial detail came from, stated before the layers themselves. */
function SourceNotice({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  if (detail.source === 'audit') return null;
  return (
    <div data-call-detail-source="session">
      <Notice kind="info" text={t('callDetail.partialSource')} />
    </div>
  );
}

/** A record whose stored format this build cannot interpret. */
function UnreadableRecord({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div data-call-detail-unreadable style={{ fontSize: 12.5 }}>
      <p style={{ margin: '0 0 8px' }}>{t('callDetail.unreadable')}</p>
      {detail.unreadableReason === null ? null : (
        <JsonBlock value={detail.unreadableReason} />
      )}
      <MissingNotices detail={detail} />
    </div>
  );
}

/**
 * The shared detail for one decoded record.
 *
 * It takes a decoded detail rather than a call id so a caller that already holds
 * a record (a future session entry, a test) renders exactly the same view
 * without a second request.
 */
export function CallDetail({
  detail,
}: {
  readonly detail: CallDetailView;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div
      data-call-detail={detail.callId}
      style={{ display: 'flex', flexDirection: 'column', gap: 12 }}
    >
      <Section
        title={t('callDetail.title', { callId: detail.callId })}
        description={t('callDetail.description')}
      >
        <SourceNotice detail={detail} />
        {detail.unreadable ? (
          <UnreadableRecord detail={detail} />
        ) : (
          <>
            <Overview detail={detail} />
            <MissingNotices detail={detail} />
            <CallDetailBasis detail={detail} />
            <CallDetailRaw detail={detail} />
          </>
        )}
      </Section>
    </div>
  );
}
