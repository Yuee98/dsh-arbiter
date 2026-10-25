import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { formatTime } from '../view-helpers.js';
import { verdictLabel } from '../log-list.js';
import type { LogRow } from '../view-types.js';

/**
 * Column widths shared by the header and every row.
 *
 * Time and verdict are bounded so the summary keeps the remaining width and is
 * the only column that truncates.
 */
const TIME_WIDTH = 160;
const VERDICT_WIDTH = 150;

/**
 * The call list: one row per call, three columns.
 *
 * Each row is a single button, so the whole row is one pointer target and one
 * tab stop that opens the detail on Enter or Space. The row carries only the
 * time, the tool with its one-line summary, and the final verdict — the reason,
 * stage chain and argument object are read when the detail opens.
 */
export function LogTable({
  rows,
  emptyText,
  onOpen,
}: {
  readonly rows: readonly LogRow[];
  readonly emptyText: string;
  readonly onOpen: (callId: string) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div>
      <div
        aria-hidden="true"
        style={{
          display: 'grid',
          gridTemplateColumns: `${String(TIME_WIDTH)}px 1fr ${String(VERDICT_WIDTH)}px`,
          gap: 8,
          padding: 6,
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
          borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        }}
      >
        <span>{t('logs.time')}</span>
        <span>{t('logs.summary')}</span>
        <span>{t('logs.verdict')}</span>
      </div>
      {rows.length === 0 ? (
        <p
          style={{
            margin: 0,
            padding: 12,
            fontSize: 12,
            color: 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {emptyText}
        </p>
      ) : (
        <ul
          aria-label={t('logs.title')}
          style={{ listStyle: 'none', margin: 0, padding: 0 }}
        >
          {rows.map((row) => (
            <li key={row.callId}>
              <button
                type="button"
                onClick={() => {
                  onOpen(row.callId);
                }}
                style={{
                  display: 'grid',
                  gridTemplateColumns: `${String(TIME_WIDTH)}px 1fr ${String(VERDICT_WIDTH)}px`,
                  gap: 8,
                  alignItems: 'start',
                  width: '100%',
                  padding: 6,
                  border: 0,
                  borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
                  background: 'transparent',
                  color: 'var(--dsw-alias-label-primary)',
                  font: 'inherit',
                  fontSize: 12,
                  textAlign: 'left',
                  cursor: 'pointer',
                }}
              >
                <span style={{ whiteSpace: 'nowrap' }}>
                  {formatTime(row.ts)}
                </span>
                <span style={{ minWidth: 0 }}>
                  <span
                    style={{ fontFamily: 'var(--dsw-font-mono, monospace)' }}
                  >
                    {row.tool}
                  </span>
                  <span
                    style={{
                      marginLeft: 8,
                      color: 'var(--dsw-alias-label-secondary)',
                    }}
                  >
                    {row.command}
                  </span>
                  {row.unreadable ? (
                    <span
                      style={{
                        display: 'block',
                        color: 'var(--dsw-alias-label-tertiary)',
                        fontSize: 11.5,
                      }}
                    >
                      {t('logs.unreadableRow')}
                    </span>
                  ) : null}
                </span>
                <span>{verdictLabel(t, row.result)}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
