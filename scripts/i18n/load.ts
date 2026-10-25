import { Ajv } from 'ajv';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  flattenCatalog,
  inspectCatalog,
} from '../../src/client/i18n/catalog.ts';
import type {
  LocaleModules,
  LocaleResources,
  LocaleTree,
} from '../../src/client/i18n/catalog.ts';

interface LocaleInspection {
  readonly resources: LocaleResources;
  readonly problems: readonly string[];
}

/** Read every language directory, independently of the client import inventory. */
export async function inspectLocaleDirectory(
  root: string,
  options: { readonly requireComplete: boolean },
): Promise<LocaleInspection> {
  const schema: unknown = JSON.parse(
    await readFile(join(root, 'schema.json'), 'utf8'),
  );
  if (schema === null || typeof schema !== 'object')
    throw new Error('Invalid locale schema');
  const validate = new Ajv({
    allErrors: true,
    strict: true,
  }).compile<LocaleTree>(schema);
  const resources: Record<string, LocaleModules> = {};
  const problems: string[] = [];
  for (const entry of (await readdir(root, { withFileTypes: true })).sort(
    (a, b) => a.name.localeCompare(b.name),
  )) {
    if (entry.isDirectory()) {
      if (!/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(entry.name)) {
        problems.push(`Invalid locale language directory: ${entry.name}`);
        continue;
      }
      const modules: Record<string, LocaleTree> = {};
      const directory = join(root, entry.name);
      for (const file of (
        await readdir(directory, { withFileTypes: true })
      ).sort((a, b) => a.name.localeCompare(b.name))) {
        const path = `${entry.name}/${file.name}`;
        if (!file.isFile() || !/^[a-z][A-Za-z0-9]*\.json$/.test(file.name)) {
          problems.push(`Invalid locale module path: ${path}`);
          continue;
        }
        try {
          const data: unknown = JSON.parse(
            await readFile(join(directory, file.name), 'utf8'),
          );
          if (validate(data)) modules[file.name.slice(0, -5)] = data;
          else
            for (const error of validate.errors ?? []) {
              problems.push(
                `${path}${error.instancePath}: ${error.message ?? error.keyword}`,
              );
            }
        } catch (error) {
          problems.push(
            `${path}: ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      resources[entry.name] = modules;
    } else if (entry.name.endsWith('.json') && entry.name !== 'schema.json') {
      problems.push(
        `Locale JSON must be inside a language directory: ${entry.name}`,
      );
    }
  }
  const source = resources['zh'];
  if (source === undefined) problems.push('Missing source locale: zh');
  for (const [language, modules] of Object.entries(resources)) {
    try {
      const catalog = flattenCatalog(modules);
      if (language === 'zh' && Object.keys(catalog).length === 0)
        problems.push('Empty source locale: zh');
      if (language !== 'zh' && source !== undefined) {
        problems.push(
          ...inspectCatalog(source, modules, { ...options, language }),
        );
      }
    } catch (error) {
      problems.push(
        `${language}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { resources, problems };
}
