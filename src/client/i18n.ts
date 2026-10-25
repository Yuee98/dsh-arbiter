import { createLocaleCatalogs } from './i18n/catalog.js';
import type { LocaleCatalog, ResourceKey } from './i18n/catalog.js';
import { localeResources } from './i18n/resources.js';

export const ARBITER_LOCALE_NAMESPACE = 'dsh-arbiter';
export type TranslationKey = ResourceKey<typeof localeResources.zh>;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type Translate = (
  key: TranslationKey,
  params?: TranslationParams,
) => string;

/** Narrow public dsh-client-locale API; the host owns preference and persistence. */
export interface LocaleService {
  register(
    namespace: string,
    dictionaries: Readonly<Record<string, LocaleCatalog>>,
  ): () => void;
  bind(namespace: string): (key: string, params?: TranslationParams) => string;
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
}

export interface ArbiterI18n {
  readonly translate: Translate;
  readonly getSnapshot: () => unknown;
  readonly subscribe: (listener: () => void) => () => void;
  readonly dispose: () => void;
}

/** Register once per plugin lifetime; missing translations intentionally render Chinese. */
export function createArbiterI18n(locale: LocaleService): ArbiterI18n {
  const dispose = locale.register(
    ARBITER_LOCALE_NAMESPACE,
    createLocaleCatalogs(localeResources),
  );
  return {
    translate: locale.bind(ARBITER_LOCALE_NAMESPACE),
    getSnapshot: () => locale.getSnapshot(),
    subscribe: (listener) => locale.subscribe(listener),
    dispose,
  };
}
