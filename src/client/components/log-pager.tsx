import type { ReactNode } from 'react';
import { Button } from './controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { pageInfo } from '../log-list.js';
import type { LogQuery } from '../log-list.js';

/**
 * The list's pager: the current position, the total, and the two moves.
 *
 * A page is only ever moved by this control, so a new record arriving can never
 * change what the reader is looking at. Both buttons disable at their boundary
 * instead of clamping a click into a no-op request.
 */
export function LogPager({
  query,
  total,
  busy,
  onOffset,
}: {
  readonly query: LogQuery;
  readonly total: number;
  readonly busy: boolean;
  readonly onOffset: (offset: number) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const info = pageInfo(query.offset, query.limit, total);
  const atStart = query.offset <= 0;
  const atEnd = info.pages === 0 || info.page >= info.pages;
  return (
    <nav
      aria-label={t('logs.pager.label')}
      style={{
        display: 'flex',
        gap: 8,
        alignItems: 'center',
        flexWrap: 'wrap',
        fontSize: 12,
      }}
    >
      <Button
        onClick={() => {
          onOffset(Math.max(query.offset - query.limit, 0));
        }}
        disabled={busy || atStart}
      >
        {t('logs.pager.previous')}
      </Button>
      <Button
        onClick={() => {
          onOffset(query.offset + query.limit);
        }}
        disabled={busy || atEnd}
      >
        {t('logs.pager.next')}
      </Button>
      <span style={{ color: 'var(--dsw-alias-label-secondary)' }}>
        {info.pages === 0
          ? t('logs.pager.empty')
          : t('logs.pager.position', {
              page: info.page,
              pages: info.pages,
            })}
      </span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
        {info.pages === 0
          ? ''
          : t('logs.pager.range', { first: info.first, last: info.last })}
      </span>
      <span style={{ color: 'var(--dsw-alias-label-tertiary)' }}>
        {t('logs.total', { count: total })}
      </span>
    </nav>
  );
}
