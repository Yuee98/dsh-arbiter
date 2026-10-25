import { logsResponse, logResponse } from '../decoders/logs.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { getJson } from '../api.js';
import { Button, JsonBlock, Notice, Section } from '../components/controls.js';
import { LogFilters } from '../components/log-filters.js';
import { LogPager } from '../components/log-pager.js';
import { LogTable } from '../components/log-table.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import {
  clampToLastPage,
  hasFilters,
  initialQuery,
  paramsOf,
  withFilters,
} from '../log-list.js';
import type { LogAnchor, LogDetail, LogRow } from '../view-types.js';
import type { LogQuery } from '../log-list.js';
import { errorText, formatTime } from '../view-helpers.js';

/** What one committed page response contains, including its traversal anchor. */
interface LoadedPage {
  readonly rows: readonly LogRow[];
  readonly total: number;
  readonly anchor: LogAnchor | null;
  readonly newer: number;
}

/**
 * The call log: a bounded, filterable page list with on-demand details.
 *
 * Three state rules the panel has to keep, each of which used to be absent:
 *
 * - The request generation decides who may commit. A slow response for an older
 *   filter can arrive after a newer one; without the guard it would replace the
 *   rows while the controls still show the new filter.
 * - The traversal anchor, not the current newest record, decides which rows a
 *   page may contain. That is what keeps a reader on a historical page when a
 *   new call arrives.
 * - A window that outlives its rows is corrected by one bounded re-request. The
 *   last page being cleared must not leave an empty table above a nonzero total.
 */
export function LogsPanel(): ReactNode {
  const t = useArbiterTranslation();
  const [query, setQuery] = useState<LogQuery>(initialQuery);
  const [draft, setDraft] = useState<LogQuery>(initialQuery);
  const [loaded, setLoaded] = useState<LoadedPage | null>(null);
  const [anchor, setAnchor] = useState<LogAnchor | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<LogDetail | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  /** Monotonic guard: only the newest request may commit its result. */
  const generation = useRef(0);

  const load = useCallback(
    async (
      next: LogQuery,
      options: {
        readonly keepAnchor: LogAnchor | null;
        /** True for the one corrective read after a window fell off the end. */
        readonly corrected?: boolean;
        readonly refresh?: boolean;
      },
    ): Promise<void> => {
      generation.current += 1;
      const current = generation.current;
      setBusy(true);
      setError(null);
      const params = paramsOf(next);
      if (options.keepAnchor !== null) {
        params.set('anchorTs', String(options.keepAnchor.ts));
        params.set('anchorCallId', options.keepAnchor.callId);
      }
      try {
        const response = await getJson(
          `/logs?${params.toString()}`,
          logsResponse,
        );
        if (generation.current !== current) return;
        // A failed read is not an empty history: the host says so explicitly,
        // and the panel must show the localized error instead of the ordinary
        // empty-state sentence.
        if (!response.ok || response.code === 'audit-unavailable') {
          setError(t('logs.auditUnavailable'));
          return;
        }
        if (
          next.offset > 0 &&
          response.rows.length === 0 &&
          response.total > 0
        ) {
          // The page this window pointed at is gone (cleared, expired, or the
          // filter shrank). One bounded correction lands on the last real page;
          // a second empty answer is reported as empty rather than retried.
          if (options.corrected !== true) {
            const target = clampToLastPage(
              next.offset,
              response.total,
              response.limit,
            );
            await load(
              { ...next, offset: target },
              {
                keepAnchor: response.anchor,
                corrected: true,
                refresh: options.refresh === true,
              },
            );
            return;
          }
        }
        // "New records" is a property of the traversal, not of the current
        // page: an anchor keeps arrivals above it out of the window. Only an
        // explicit refresh asks how many are waiting there — a total delta would
        // also fire on the first load and on every filter change, when nothing
        // arrived at all.
        const arrivals = options.refresh === true ? response.newer : 0;
        setLoaded({
          rows: response.rows,
          total: response.total,
          anchor: response.anchor,
          newer: response.newer,
        });
        setAnchor(response.anchor);
        setQuery(next);
        setDraft(next);
        setNotice(
          arrivals > 0 ? t('logs.newRecords', { count: arrivals }) : null,
        );
      } catch (errorValue) {
        if (generation.current !== current) return;
        setError(`${t('logs.loadFailed')} ${errorText(errorValue)}`);
      } finally {
        if (generation.current === current) setBusy(false);
      }
    },
    [t],
  );

  /**
   * Run one read, reporting a transport failure through the panel's error slot.
   *
   * `load` already owns the generation guard and the in-band error states; this
   * only covers the promise itself, so no event handler has to spell out a
   * catch for a read it did not await.
   */
  const run = useCallback(
    (next: LogQuery, options: Parameters<typeof load>[1]): void => {
      load(next, options).catch((failure: unknown) => {
        setError(`${t('logs.loadFailed')} ${errorText(failure)}`);
      });
    },
    [load, t],
  );

  useEffect(() => {
    // The initial read runs once; every later read is an explicit interaction,
    // which is what keeps a new record from moving the reader's page.
    run(initialQuery(), { keepAnchor: null });
  }, [run]);

  /** Every filter is confirmed through here, so a change always restarts the set. */
  const applyFilters = (): void => {
    run(withFilters(draft, {}), { keepAnchor: null });
  };

  const clearFilters = (): void => {
    run(initialQuery(), { keepAnchor: null });
  };

  const moveTo = (offset: number): void => {
    if (loaded === null) return;
    run(
      { ...query, offset: clampToLastPage(offset, loaded.total, query.limit) },
      { keepAnchor: anchor },
    );
  };

  const backToLatest = (): void => {
    run({ ...query, offset: 0 }, { keepAnchor: null });
  };

  const refresh = (): void => {
    run(query, { keepAnchor: anchor, refresh: true });
  };

  /** Open one call's detail through the existing detail entry point. */
  const open = (callId: string): void => {
    setBusy(true);
    setError(null);
    getJson(`/log?callId=${encodeURIComponent(callId)}`, logResponse)
      .then((response) => {
        setDetail(response.record);
      })
      .catch((errorValue: unknown) => {
        setError(`${t('logs.loadFailed')} ${errorText(errorValue)}`);
      })
      .finally(() => {
        setBusy(false);
      });
  };

  const rows = loaded?.rows ?? [];
  const total = loaded?.total ?? 0;
  const emptyText =
    total === 0
      ? hasFilters(query)
        ? t('logs.emptyFiltered')
        : t('logs.empty')
      : t('logs.emptyPage');

  return (
    <>
      <Section title={t('logs.title')} description={t('logs.description')}>
        <LogFilters
          draft={draft}
          onDraft={setDraft}
          onApply={applyFilters}
          onClear={clearFilters}
        />
        <div
          style={{
            display: 'flex',
            gap: 8,
            alignItems: 'center',
            flexWrap: 'wrap',
          }}
        >
          <Button onClick={refresh} disabled={busy} tone="primary">
            {busy ? t('logs.loading') : t('logs.refresh')}
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
                {notice}
              </span>
              <Button onClick={backToLatest} disabled={busy}>
                {t('logs.backToLatest')}
              </Button>
            </>
          )}
        </div>
        {error === null ? null : <Notice kind="error" text={error} />}
        <LogTable
          rows={rows}
          emptyText={error === null ? emptyText : ''}
          onOpen={open}
        />
        <LogPager query={query} total={total} busy={busy} onOffset={moveTo} />
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
