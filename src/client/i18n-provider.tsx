import { createContext, useContext, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';

import type { ArbiterI18n, Translate } from './i18n.js';

const I18nContext = createContext<ArbiterI18n | null>(null);

export function ArbiterI18nProvider(props: {
  readonly i18n: ArbiterI18n;
  readonly children: ReactNode;
}): ReactNode {
  return (
    <I18nContext.Provider value={props.i18n}>
      {props.children}
    </I18nContext.Provider>
  );
}

/** Host snapshot changes include both live language switches and dictionaries. */
export function useArbiterTranslation(): Translate {
  const i18n = useContext(I18nContext);
  if (i18n === null)
    throw new Error('Arbiter UI requires its host locale provider');
  useSyncExternalStore(i18n.subscribe, i18n.getSnapshot, i18n.getSnapshot);
  return i18n.translate;
}
