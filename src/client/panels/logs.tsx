import { logsResponse, logResponse } from '../decoders/logs.js';
import { useCallback, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { getJson } from '../api.js';
import {
  Button,
  Field,
  JsonBlock,
  Notice,
  Section,
  Select,
  TextInput,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { errorText, formatTime } from '../view-helpers.js';
import type { LogRow, LogDetail } from '../view-types.js';

export function LogsPanel(): ReactNode {
  const t = useArbiterTranslation();
  const [rows, setRows] = useState<readonly LogRow[]>([]);
  const [total, setTotal] = useState(0);
  const [result, setResult] = useState('');
  const [query, setQuery] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const params = new URLSearchParams({ limit: '100' });
      if (result.length > 0) params.set('result', result);
      if (query.length > 0) params.set('q', query);
      const response = await getJson(
        `/logs?${params.toString()}`,
        logsResponse,
      );
      setRows(response.rows);
      setTotal(response.total);
      if (response.code === 'audit-unavailable')
        setError(t('logs.auditUnavailable'));
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  }, [query, result, t]);

  useEffect(() => {
    load().catch((failure: unknown) => {
      setError(errorText(failure));
    });
  }, [load]);

  const open = async (callId: string): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const response = await getJson(
        `/log?callId=${encodeURIComponent(callId)}`,
        logResponse,
      );
      setDetail(response.record);
    } catch (errorValue) {
      setError(errorText(errorValue));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Section title={t('logs.title')} description={t('logs.description')}>
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'flex-end',
            flexWrap: 'wrap',
          }}
        >
          <div style={{ width: 180 }}>
            <Field label={t('logs.result')}>
              <Select
                value={result}
                options={
                  [
                    '',
                    'allow',
                    'deny',
                    'review-allow',
                    'review-deny',
                    'review-escalate',
                    'human-allow',
                    'human-deny',
                    'human-abort',
                    'fallback-deny',
                  ] as const
                }
                labels={{ '': t('logs.all') }}
                onChange={setResult}
              />
            </Field>
          </div>
          <div style={{ width: 260 }}>
            <Field label={t('logs.search')}>
              <TextInput
                value={query}
                onChange={setQuery}
                placeholder={t('logs.searchPlaceholder')}
              />
            </Field>
          </div>
          <Button
            onClick={() => {
              load().catch((failure: unknown) => {
                setError(errorText(failure));
              });
            }}
            disabled={busy}
            tone="primary"
          >
            {busy ? t('logs.loading') : t('logs.refresh')}
          </Button>
          <span
            style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}
          >
            {t('logs.total', { count: total })}
          </span>
        </div>
        {error === null ? null : <Notice kind="error" text={error} />}
        <LogTable
          rows={rows}
          onOpen={(callId) => {
            open(callId).catch((failure: unknown) => {
              setError(errorText(failure));
            });
          }}
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
      {detail.normalization === null ? null : (
        <details>
          <summary style={{ cursor: 'pointer', fontSize: 13 }}>
            {t('logs.normalization')}
          </summary>
          <JsonBlock value={detail.normalization} />
        </details>
      )}
      <details>
        <summary style={{ cursor: 'pointer', fontSize: 13 }}>
          {t('logs.modelCalls', { count: detail.modelCalls.length })}
        </summary>
        <JsonBlock value={detail.modelCalls} />
      </details>
    </Section>
  );
}

function LogTable({
  rows,
  onOpen,
}: {
  readonly rows: readonly LogRow[];
  readonly onOpen: (callId: string) => void;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <table style={{ borderCollapse: 'collapse', width: '100%', fontSize: 12 }}>
      <thead>
        <tr
          style={{
            textAlign: 'left',
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          <th style={{ padding: 6 }}>{t('logs.time')}</th>
          <th style={{ padding: 6 }}>{t('logs.tool')}</th>
          <th style={{ padding: 6 }}>{t('logs.command')}</th>
          <th style={{ padding: 6 }}>{t('logs.result')}</th>
          <th style={{ padding: 6 }}>{t('logs.rule')}</th>
          <th style={{ padding: 6 }}>{t('logs.approvalMode')}</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr
            key={row.callId}
            onClick={() => {
              onOpen(row.callId);
            }}
            style={{
              borderTop: '0.5px solid var(--dsw-alias-border-l2)',
              cursor: 'pointer',
              verticalAlign: 'top',
            }}
          >
            <td style={{ padding: 6, whiteSpace: 'nowrap' }}>
              {formatTime(row.ts)}
            </td>
            <td
              style={{
                padding: 6,
                fontFamily: 'var(--dsw-font-mono, monospace)',
              }}
            >
              {row.tool}
            </td>
            <td
              style={{
                padding: 6,
                fontFamily: 'var(--dsw-font-mono, monospace)',
                maxWidth: 420,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {row.command}
            </td>
            <td style={{ padding: 6 }}>{row.result}</td>
            <td style={{ padding: 6 }}>{row.ruleId ?? '—'}</td>
            <td style={{ padding: 6 }}>{row.approvalMode}</td>
          </tr>
        ))}
        {rows.length === 0 ? (
          <tr>
            <td
              colSpan={6}
              style={{
                padding: 12,
                color: 'var(--dsw-alias-label-tertiary)',
              }}
            >
              {t('logs.empty')}
            </td>
          </tr>
        ) : null}
      </tbody>
    </table>
  );
}
