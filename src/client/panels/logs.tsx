import { logResponse } from '../decoders/logs.js';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { getJson } from '../api.js';
import { Button, JsonBlock, Notice, Section } from '../components/controls.js';
import { LogFilters } from '../components/log-filters.js';
import { LogPager } from '../components/log-pager.js';
import { LogTable } from '../components/log-table.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { useLogPages } from '../log-pages.js';
import type { LogDetail } from '../view-types.js';
import { errorText, formatTime } from '../view-helpers.js';

/**
 * The call log: a bounded, filterable page list with on-demand details.
 *
 * Paging state lives in `useLogPages`, which owns the request generation, the
 * cursor and the one bounded correction; this component is the wiring and the
 * presentation. Details stay on demand through the existing entry point, and
 * the panel never reads a call's prompt or response to render the list.
 */
export function LogsPanel(): ReactNode {
  const t = useArbiterTranslation();
  const pages = useLogPages();
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [detailBusy, setDetailBusy] = useState(false);

  /** Open one call's detail through the existing detail entry point. */
  const open = (callId: string): void => {
    setDetailBusy(true);
    setDetailError(null);
    getJson(`/log?callId=${encodeURIComponent(callId)}`, logResponse)
      .then((response) => {
        setDetail(response.record);
      })
      .catch((errorValue: unknown) => {
        setDetailError(`${t('logs.loadFailed')} ${errorText(errorValue)}`);
      })
      .finally(() => {
        setDetailBusy(false);
      });
  };

  const notice = pages.notice;
  return (
    <>
      <Section title={t('logs.title')} description={t('logs.description')}>
        <LogFilters
          draft={pages.draft}
          onDraft={pages.setDraft}
          onApply={pages.applyFilters}
          onClear={pages.clearFilters}
        />
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Button onClick={pages.refresh} disabled={pages.busy} tone="primary">
            {pages.busy ? t('logs.loading') : t('logs.refresh')}
          </Button>
          {notice === null ? null : (
            <>
              <span
                role="status"
                style={{
                  fontSize: 12,
                  color: 'var(--dsw-alias-label-secondary)',
                }}
              >
                {t('logs.newRecords', { count: notice.count })}
              </span>
              <Button onClick={pages.backToLatest} disabled={pages.busy}>
                {t('logs.backToLatest')}
              </Button>
            </>
          )}
        </div>
        {pages.error === null ? null : (
          <Notice kind="error" text={pages.error} />
        )}
        {detailError === null ? null : (
          <Notice kind="error" text={detailError} />
        )}
        <LogTable
          rows={pages.loaded?.rows ?? []}
          emptyText={pages.error === null ? pages.emptyText : ''}
          onOpen={open}
        />
        <LogPager
          query={pages.query}
          index={pages.index}
          total={pages.loaded?.total ?? 0}
          remaining={pages.loaded?.remaining ?? 0}
          hasNext={pages.hasNext}
          hasPrevious={pages.hasPrevious}
          busy={pages.busy || detailBusy}
          onNext={pages.next}
          onPrevious={pages.previous}
        />
      </Section>
      {detail === null ? null : <CallDetails detail={detail} />}
    </>
  );
}

function CallDetails({ detail }: { readonly detail: LogDetail }): ReactNode {
  const t = useArbiterTranslation();

  return (
    <Section
      title={t('logs.detailTitle', { value: detail.callId })}
      description={`${formatTime(detail.ts)} · ${detail.sessionKind} · ${detail.executionMode}`}
    >
      <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
        <tbody>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.permissionResult')}
            </td>
            <td>{detail.result}</td>
          </tr>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.executionStatus')}
            </td>
            <td>{detail.executionStatus}</td>
          </tr>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.reason')}
            </td>
            <td>{detail.reason}</td>
          </tr>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.revision')}
            </td>
            <td>
              <code>{detail.configRevision}</code>
            </td>
          </tr>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.sessionRecord')}
            </td>
            <td>{detail.sessionRecordState}</td>
          </tr>
          <tr>
            <td
              style={{
                padding: '3px 12px 3px 0',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              {t('logs.fingerprint')}
            </td>
            <td>
              <code>{detail.fingerprint}</code>
            </td>
          </tr>
        </tbody>
      </table>
      <div>
        <strong style={{ fontSize: 13 }}>{t('logs.chain')}</strong>
        <ol style={{ margin: '6px 0 0', paddingLeft: 20, fontSize: 12.5 }}>
          {detail.stages.map((stage) => (
            <li key={`${String(stage.seq)}-${stage.stage}`}>
              {stage.stage} → {stage.result}
              {stage.ruleId === null ? '' : ` (${stage.ruleId})`}
              {stage.decisionRules.length === 0
                ? ''
                : ` [${stage.decisionRules.join(', ')}]`}
              {stage.reason === null ? '' : ` — ${stage.reason}`}
            </li>
          ))}
        </ol>
      </div>
      <details open>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>
          {t('logs.snapshot')}
        </summary>
        <JsonBlock value={detail.snapshot} />
      </details>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>
          {t('logs.signals')}
        </summary>
        <JsonBlock
          value={{
            signals: detail.signals,
            policyStrategy: detail.policyStrategy,
            decisionRules: detail.decisionRules,
            config: detail.config,
          }}
        />
      </details>
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>
          {t('logs.modelCalls', { count: detail.modelCalls.length })}
        </summary>
        <JsonBlock value={detail.modelCalls} />
      </details>
    </Section>
  );
}
