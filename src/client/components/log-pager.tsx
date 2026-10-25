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
 *
 * `index` is how many rows the reader has passed. With keyset paging the server
 * does not report an offset — the position is derived from the rows actually
 * read, so a cleanup that shrinks the total cannot claim the reader is on a page
 * that no longer exists.
 */
export function LogPager({
  query,
  index,
  total,
  hasNext,
  hasPrevious,
  busy,
  onNext,
  onPrevious,
}: {
  readonly query: LogQuery;
  readonly index: number;
  readonly total: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly busy: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const info = pageInfo(index, query.limit, total);
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
      <Button onClick={onPrevious} disabled={busy || !hasPrevious}>
        {t('logs.pager.previous')}
      </Button>
      <Button onClick={onNext} disabled={busy || !hasNext}>
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
