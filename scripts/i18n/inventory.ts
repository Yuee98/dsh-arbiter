import { isDeepStrictEqual } from 'node:util';
import type { LocaleResources } from '../../src/client/i18n/catalog.ts';

/** A valid disk resource must also reach the browser bundle, without silent omissions. */
export function inspectLocaleInventory(
  disk: LocaleResources,
  registered: LocaleResources,
): readonly string[] {
  const problems: string[] = [];
  for (const language of new Set([
    ...Object.keys(disk),
    ...Object.keys(registered),
  ])) {
    const actual = disk[language];
    const imports = registered[language];
    if (actual === undefined || imports === undefined) {
      problems.push(`Locale directory/registration mismatch: ${language}`);
      continue;
    }
    for (const module of new Set([
      ...Object.keys(actual),
      ...Object.keys(imports),
    ])) {
      if (!isDeepStrictEqual(actual[module], imports[module])) {
        problems.push(
          `Locale module/registration mismatch: ${language}/${module}.json`,
        );
      }
    }
  }
  return problems;
}
