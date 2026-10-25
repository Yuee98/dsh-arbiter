export type LocaleCatalog = Readonly<Record<string, string>>;

const SEMANTIC_KEY = /^[a-z][A-Za-z0-9]*(?:\.[a-z][A-Za-z0-9]*)*$/;
const PLACEHOLDER = /\{(\w+)\}/g;

function placeholders(text: string): string {
  return [...new Set([...text.matchAll(PLACEHOLDER)].map((match) => match[1]))]
    .sort()
    .join(',');
}

/** Development permits untranslated English keys; release validation does not. */
export function inspectCatalog(
  chinese: LocaleCatalog,
  english: LocaleCatalog,
  options: { readonly requireComplete: boolean },
): readonly string[] {
  const problems: string[] = [];
  for (const [key, value] of Object.entries(chinese)) {
    if (!SEMANTIC_KEY.test(key)) problems.push(`Invalid semantic key: ${key}`);
    if (value.trim() === '') problems.push(`Empty Chinese translation: ${key}`);
    const translated = english[key];
    if (translated === undefined) {
      if (options.requireComplete)
        problems.push(`Missing English translation: ${key}`);
    } else if (translated.trim() === '') {
      problems.push(`Empty English translation: ${key}`);
    } else if (placeholders(value) !== placeholders(translated)) {
      problems.push(`Translation placeholders differ: ${key}`);
    }
  }
  for (const key of Object.keys(english)) {
    if (!Object.hasOwn(chinese, key))
      problems.push(`Unknown English key: ${key}`);
  }
  return problems;
}
