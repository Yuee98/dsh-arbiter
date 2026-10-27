import { useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { CallDetailPanel } from '../components/call-detail-panel.js';
import { Button, Notice, Section } from '../components/controls.js';
import { LogFilters } from '../components/log-filters.js';
import { LogPager } from '../components/log-pager.js';
import { LogTable } from '../components/log-table.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { useLogPages } from '../log-pages.js';

/**
 * The call log and its shared detail entry.
 *
 * Paging state lives in `useLogPages`, which owns the request generation, the
 * cursor and the one bounded correction; this component is the wiring and the
 * presentation. The list stays a locator: opening a row hands its `callId` to
 * {@link CallDetailPanel}, the same view a session entry opens, so the two paths
 * cannot drift. The panel never reads a call's prompt or response to render the
 * list.
 */
export function LogsPanel(): ReactNode {
  const t = useArbiterTranslation();
  const pages = useLogPages();
  const [openCallId, setOpenCallId] = useState<string | null>(null);
  const callDetailOpenerRef = useRef<HTMLElement | null>(null);

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
        <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-2">
          <Button onClick={pages.refresh} disabled={pages.busy} tone="primary">
            {pages.busy ? t('logs.loading') : t('logs.refresh')}
          </Button>
          {notice === null ? null : (
            <>
              <span role="status" className="arb:text-xs arb:text-secondary">
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
        <LogTable
          rows={pages.loaded?.rows ?? []}
          emptyText={pages.error === null ? pages.emptyText : ''}
          onOpen={(callId, opener) => {
            callDetailOpenerRef.current = opener ?? null;
            setOpenCallId(callId);
          }}
        />
        <LogPager
          query={pages.query}
          index={pages.index}
          total={pages.loaded?.total ?? 0}
          remaining={pages.loaded?.remaining ?? 0}
          hasNext={pages.hasNext}
          hasPrevious={pages.hasPrevious}
          busy={pages.busy}
          onNext={pages.next}
          onPrevious={pages.previous}
        />
      </Section>
      {openCallId === null ? null : (
        <CallDetailPanel
          callId={openCallId}
          openerRef={callDetailOpenerRef}
          onClose={() => {
            setOpenCallId(null);
          }}
        />
      )}
    </>
  );
}
