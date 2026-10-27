import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';
import { cn } from './ui/cn.js';

/**
 * First-release navigation. Offline rule suggestions, analysis and policy
 * replay are deferred beyond this release, so they have no tab here; the
 * prototype panel under `panels/suggestions.tsx` is not wired into the page.
 */
const TABS = [
  ['status', 'page.status'],
  ['rules', 'page.rules'],
  ['reviewer', 'page.reviewer'],
  ['advanced', 'page.advanced'],
  ['logs', 'page.logs'],
  ['about', 'page.about'],
] as const;

export type TabId = (typeof TABS)[number][0];

export function PageTabs({
  tab,
  onTab,
}: {
  readonly tab: TabId;
  readonly onTab: (tab: TabId) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <div className="arb:flex arb:flex-wrap arb:gap-1 arb:border-b arb:border-border-default">
      {TABS.map(([id, label]) => {
        const isActive = tab === id;
        return (
          <button
            key={id}
            type="button"
            onClick={() => {
              onTab(id);
            }}
            className={cn(
              'arb:cursor-pointer arb:border-b-2 arb:bg-transparent arb:px-3 arb:py-2 arb:text-xs arb:font-medium arb:transition-colors arb:focus-visible:outline-none arb:focus-visible:ring-1 arb:focus-visible:ring-accent',
              isActive
                ? 'arb:border-accent arb:text-primary'
                : 'arb:border-transparent arb:text-secondary arb:hover:text-primary',
            )}
          >
            {t(label)}
          </button>
        );
      })}
    </div>
  );
}
