import { ChevronLeft, ChevronRight, ChevronsLeft } from 'lucide-react';
import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { pageInfo } from '../log-list.js';
import type { LogQuery } from '../log-list.js';
import { IconButton } from './ui/button.js';

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
  remaining,
  hasNext,
  hasPrevious,
  busy,
  onNext,
  onPrevious,
  onFirst,
}: {
  readonly query: LogQuery;
  readonly index: number;
  readonly total: number;
  /** How many matching rows follow this page; the pager derives the rest. */
  readonly remaining: number;
  readonly hasNext: boolean;
  readonly hasPrevious: boolean;
  readonly busy: boolean;
  readonly onNext: () => void;
  readonly onPrevious: () => void;
  readonly onFirst?: (() => void) | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  const info = pageInfo(index, query.limit, total, remaining);

  return (
    <nav
      aria-label={t('logs.pager.label')}
      className="arb:flex arb:flex-wrap arb:items-center arb:justify-between arb:gap-3 arb:pt-2 arb:text-xs"
    >
      <div className="arb:inline-flex arb:items-center arb:gap-1 arb:rounded-lg arb:border arb:border-border-default arb:bg-layer-2 arb:p-1 arb:shadow-xs">
        {onFirst !== undefined ? (
          <IconButton
            label={t('logs.pager.first')}
            icon={ChevronsLeft}
            disabled={busy || !hasPrevious}
            onClick={onFirst}
          />
        ) : null}
        <IconButton
          label={t('logs.pager.previous')}
          icon={ChevronLeft}
          disabled={busy || !hasPrevious}
          onClick={onPrevious}
        />
        <div className="arb:inline-flex arb:h-7 arb:items-center arb:justify-center arb:rounded arb:bg-layer-3 arb:px-2.5 arb:text-xs arb:font-medium arb:text-primary">
          {info.pages === 0
            ? t('logs.pager.empty')
            : t('logs.pager.position', {
                page: info.page,
                pages: info.pages,
              })}
        </div>
        <IconButton
          label={t('logs.pager.next')}
          icon={ChevronRight}
          disabled={busy || !hasNext}
          onClick={onNext}
        />
      </div>

      <div className="arb:flex arb:items-center arb:gap-2 arb:text-[11.5px] arb:text-tertiary">
        {info.pages === 0 ? null : (
          <span>
            {t('logs.pager.range', { first: info.first, last: info.last })}
          </span>
        )}
        <span>{t('logs.total', { count: total })}</span>
      </div>
    </nav>
  );
}
