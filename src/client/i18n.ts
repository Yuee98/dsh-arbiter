import chinese from '../../locale/zh.json' with { type: 'json' };
import english from '../../locale/en.json' with { type: 'json' };

import type { LocaleCatalog } from './i18n/catalog.js';

export const ARBITER_LOCALE_NAMESPACE = 'dsh-arbiter';
export type TranslationKey = keyof typeof chinese;
export type TranslationParams = Readonly<Record<string, string | number>>;
export type Translate = (
  key: TranslationKey,
  params?: TranslationParams,
) => string;

/** Narrow public dsh-client-locale API; the host owns preference and persistence. */
export interface LocaleService {
  register(
    namespace: string,
    dictionaries: { readonly zh: LocaleCatalog; readonly en: LocaleCatalog },
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

/** Register once per plugin lifetime; missing English intentionally renders Chinese. */
export function createArbiterI18n(locale: LocaleService): ArbiterI18n {
  const dispose = locale.register(ARBITER_LOCALE_NAMESPACE, {
    zh: chinese,
    en: { ...chinese, ...english },
  });
  return {
    translate: locale.bind(ARBITER_LOCALE_NAMESPACE),
    getSnapshot: () => locale.getSnapshot(),
    subscribe: (listener) => locale.subscribe(listener),
    dispose,
  };
}
