import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { formatTime } from '../view-helpers.js';
import { verdictLabel } from '../log-list.js';
import type { LogRow } from '../view-types.js';

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
  readonly onOpen: (callId: string, opener?: HTMLElement | null) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div>
      <div
        aria-hidden="true"
        className="arb:grid arb:grid-cols-[160px_1fr_150px] arb:gap-2 arb:border-b arb:border-border-subtle arb:p-1.5 arb:text-xs arb:text-secondary"
      >
        <span>{t('logs.time')}</span>
        <span>{t('logs.summary')}</span>
        <span>{t('logs.verdict')}</span>
      </div>
      {rows.length === 0 ? (
        <p className="arb:m-0 arb:p-3 arb:text-xs arb:text-tertiary">
          {emptyText}
        </p>
      ) : (
        <ul
          aria-label={t('logs.title')}
          className="arb:m-0 arb:list-none arb:p-0"
        >
          {rows.map((row) => (
            <li key={row.callId}>
              <button
                type="button"
                onClick={(event) => {
                  onOpen(row.callId, event.currentTarget);
                }}
                className="arb:grid arb:w-full arb:grid-cols-[160px_1fr_150px] arb:items-start arb:gap-2 arb:border-0 arb:border-b arb:border-border-subtle arb:bg-transparent arb:p-1.5 arb:text-left arb:font-inherit arb:text-xs arb:text-primary arb:cursor-pointer hover:arb:bg-layer-2 focus-visible:arb:outline-2 focus-visible:arb:outline-offset-1 focus-visible:arb:outline-accent"
              >
                <span className="arb:whitespace-nowrap">
                  {formatTime(row.ts)}
                </span>
                <span className="arb:min-w-0">
                  <span className="arb:font-mono">{row.tool}</span>
                  <span className="arb:ml-2 arb:text-secondary">
                    {row.command}
                  </span>
                  {row.unreadable ? (
                    <span className="arb:block arb:text-[11.5px] arb:text-tertiary">
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
