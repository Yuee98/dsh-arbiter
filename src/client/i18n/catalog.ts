export type LocaleCatalog = Readonly<Record<string, string>>;
export interface LocaleTree {
  readonly [key: string]: string | LocaleTree;
}
export type LocaleModules = Readonly<Record<string, LocaleTree>>;
export type LocaleResources = Readonly<Record<string, LocaleModules>>;

type LeafKey<T> = {
  [K in keyof T & string]: T[K] extends string ? K : `${K}.${LeafKey<T[K]>}`;
}[keyof T & string];

export type ResourceKey<T extends LocaleModules> = {
  [K in keyof T & string]: K extends 'common'
    ? LeafKey<T[K]>
    : `${K}.${LeafKey<T[K]>}`;
}[keyof T & string];

function collectMessages(
  tree: LocaleTree,
  prefix: string,
): readonly (readonly [string, string])[] {
  return Object.entries(tree).flatMap(([key, value]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return typeof value === 'string'
      ? [[path, value] as const]
      : collectMessages(value, path);
  });
}

/** common keeps the existing unprefixed title/summary keys. Other files are namespaces. */
export function flattenCatalog(modules: LocaleModules): LocaleCatalog {
  const messages = new Map<string, string>();
  for (const [module, tree] of Object.entries(modules)) {
    for (const [key, value] of collectMessages(
      tree,
      module === 'common' ? '' : module,
    )) {
      if (messages.has(key))
        throw new Error(`Duplicate translation key: ${key}`);
      messages.set(key, value);
    }
  }
  for (const key of messages.keys()) {
    const parts = key.split('.');
    while (parts.length > 1) {
      parts.pop();
      const parent = parts.join('.');
      if (messages.has(parent))
        throw new Error(`Translation object/string conflict: ${parent}`);
    }
  }
  return Object.fromEntries(messages);
}

/** Flatten before merging so partial translations never replace a whole Chinese group. */
export function createLocaleCatalogs(
  resources: LocaleResources,
): Readonly<Record<string, LocaleCatalog>> {
  const source = resources['zh'];
  if (source === undefined) throw new Error('Missing source locale: zh');
  const chinese = flattenCatalog(source);
  return Object.fromEntries(
    Object.entries(resources).map(([language, modules]) => [
      language,
      { ...chinese, ...flattenCatalog(modules) },
    ]),
  );
}

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]))]
    .sort()
    .join(',');
}

function compareTree(
  source: LocaleTree,
  translated: LocaleTree,
  path: string,
  language: string,
): readonly string[] {
  return Object.entries(translated).flatMap(([key, value]) => {
    const fullKey = path ? `${path}.${key}` : key;
    const expected = Object.hasOwn(source, key) ? source[key] : undefined;
    if (expected === undefined) return [`Unknown ${language} key: ${fullKey}`];
    if (typeof value === 'string' && typeof expected === 'string') {
      return placeholders(value) === placeholders(expected)
        ? []
        : [`Translation placeholders differ (${language}): ${fullKey}`];
    }
    if (typeof value === 'object' && typeof expected === 'object') {
      return compareTree(expected, value, fullKey, language);
    }
    return [`Translation object/string conflict (${language}): ${fullKey}`];
  });
}

/** Schema validation precedes this cross-language comparison, for every language. */
export function inspectCatalog(
  source: LocaleModules,
  translated: LocaleModules,
  options: { readonly language: string; readonly requireComplete: boolean },
): readonly string[] {
  const problems = Object.entries(translated).flatMap(([module, tree]) => {
    const expected = Object.hasOwn(source, module) ? source[module] : undefined;
    return expected === undefined
      ? [`Unknown ${options.language} module: ${module}`]
      : compareTree(
          expected,
          tree,
          module === 'common' ? '' : module,
          options.language,
        );
  });
  if (!options.requireComplete) return problems;
  const sourceMessages = flattenCatalog(source);
  const translatedMessages = flattenCatalog(translated);
  return [
    ...problems,
    ...Object.keys(sourceMessages)
      .filter((key) => !Object.hasOwn(translatedMessages, key))
      .map((key) => `Missing ${options.language} translation: ${key}`),
  ];
}
