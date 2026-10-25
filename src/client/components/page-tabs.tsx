import type { ReactNode } from 'react';
import { useArbiterTranslation } from '../i18n-provider.js';

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
    <div
      style={{
        display: 'flex',
        gap: 4,
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
        flexWrap: 'wrap',
      }}
    >
      {TABS.map(([id, label]) => (
        <button
          key={id}
          type="button"
          onClick={() => {
            onTab(id);
          }}
          style={{
            padding: '8px 12px',
            border: 0,
            borderBottom:
              tab === id
                ? '2px solid var(--dsw-alias-state-business-primary)'
                : '2px solid transparent',
            background: 'transparent',
            color:
              tab === id
                ? 'var(--dsw-alias-label-primary)'
                : 'var(--dsw-alias-label-secondary)',
            cursor: 'pointer',
            fontSize: 12.5,
          }}
        >
          {t(label)}
        </button>
      ))}
    </div>
  );
}
