import type {
  LocaleService,
  TranslationParams,
} from '../../src/client/i18n.js';
import type { LocaleCatalog } from '../../src/client/i18n/catalog.js';

/** The public locale boundary only; components and Arbiter's adapter remain real. */
export function createTestLocale(initialLocale = 'zh'): LocaleService & {
  readonly setLocale: (locale: string) => void;
} {
  let currentLocale = initialLocale;
  let snapshot = { active: currentLocale, revision: 0 };
  const listeners = new Set<() => void>();
  const namespaces = new Map<string, Readonly<Record<string, LocaleCatalog>>>();
  return {
    register(namespace, dictionaries) {
      if (namespaces.has(namespace))
        throw new Error(`Duplicate test locale namespace: ${namespace}`);
      namespaces.set(namespace, dictionaries);
      return () => {
        namespaces.delete(namespace);
      };
    },
    bind(namespace) {
      return (key: string, params?: TranslationParams): string => {
        const template =
          namespaces.get(namespace)?.[currentLocale]?.[key] ?? key;
        return template.replace(/\{(\w+)\}/g, (match: string, name: string) =>
          params?.[name] === undefined ? match : String(params[name]),
        );
      };
    },
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    setLocale(locale) {
      currentLocale = locale;
      snapshot = { active: locale, revision: snapshot.revision + 1 };
      for (const listener of listeners) listener();
    },
  };
}
