import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { inspectLocaleDirectory } from '../../scripts/i18n/load.js';
import { inspectLocaleInventory } from '../../scripts/i18n/inventory.js';

let root: string;

async function moduleFile(
  language: string,
  data: unknown,
  name = 'config',
): Promise<void> {
  await mkdir(join(root, language), { recursive: true });
  await writeFile(join(root, language, `${name}.json`), JSON.stringify(data));
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-i18n-'));
  await writeFile(
    join(root, 'schema.json'),
    await readFile(new URL('../../locale/schema.json', import.meta.url)),
  );
  await moduleFile('zh', {
    saved: '已保存 {count}',
    actions: { cancel: '取消' },
  });
  await moduleFile('en', { saved: 'Saved {count}' });
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('locale directory validation', () => {
  it('discovers a third language and validates its nested resources', async () => {
    await moduleFile('fr', { saved: 'Enregistré {count}' });
    const result = await inspectLocaleDirectory(root, {
      requireComplete: false,
    });
    expect(result.problems).toEqual([]);
    expect(Object.keys(result.resources)).toEqual(['en', 'fr', 'zh']);
    expect(result.resources['fr']).toEqual({
      config: { saved: 'Enregistré {count}' },
    });
  });

  it.each(['zh', 'en', 'fr'])(
    'applies the shared schema to %s as well as other languages',
    async (language) => {
      await moduleFile(language, { actions: { cancel: null } });
      const result = await inspectLocaleDirectory(root, {
        requireComplete: false,
      });
      expect(result.problems).toEqual(
        expect.arrayContaining([
          expect.stringContaining(`${language}/config.json/actions/cancel`),
        ]),
      );
    },
  );

  it.each([
    [],
    42,
    true,
    null,
    { actions: { cancel: '  \n ' } },
    { 'actions.cancel': 'Cancel' },
  ])('rejects malformed modules: %j', async (data) => {
    await moduleFile('fr', data);
    const result = await inspectLocaleDirectory(root, {
      requireComplete: false,
    });
    expect(
      result.problems.some((problem) => problem.startsWith('fr/config.json')),
    ).toBe(true);
  });

  it('reports malformed JSON with its actual file path', async () => {
    await writeFile(join(root, 'en/config.json'), '{ broken');
    const result = await inspectLocaleDirectory(root, {
      requireComplete: false,
    });
    expect(result.problems).toEqual(
      expect.arrayContaining([expect.stringContaining('en/config.json:')]),
    );
  });

  it('allows missing files in development but requires every language at release', async () => {
    await mkdir(join(root, 'fr'));
    expect(
      (await inspectLocaleDirectory(root, { requireComplete: false })).problems,
    ).toEqual([]);
    const release = await inspectLocaleDirectory(root, {
      requireComplete: true,
    });
    expect(release.problems).toEqual(
      expect.arrayContaining([
        'Missing en translation: config.actions.cancel',
        'Missing fr translation: config.saved',
        'Missing fr translation: config.actions.cancel',
      ]),
    );
    const complete = { saved: 'Saved {count}', actions: { cancel: 'Cancel' } };
    await moduleFile('en', complete);
    await moduleFile('fr', complete);
    expect(
      (await inspectLocaleDirectory(root, { requireComplete: true })).problems,
    ).toEqual([]);
  });

  it('checks placeholders, unknown empty branches and tree conflicts in a third language', async () => {
    await moduleFile('fr', {
      saved: 'Enregistré {total}',
      actions: 'Annuler',
      extra: {},
    });
    expect(
      (await inspectLocaleDirectory(root, { requireComplete: false })).problems,
    ).toEqual([
      'Translation placeholders differ (fr): config.saved',
      'Translation object/string conflict (fr): config.actions',
      'Unknown fr key: config.extra',
    ]);
  });

  it('detects a root legacy catalog and source namespace collisions', async () => {
    await writeFile(join(root, 'en.json'), '{}');
    await moduleFile('zh', { config: { saved: '覆盖' } }, 'common');
    const result = await inspectLocaleDirectory(root, {
      requireComplete: false,
    });
    expect(result.problems).toEqual(
      expect.arrayContaining([
        'Locale JSON must be inside a language directory: en.json',
        'zh: Duplicate translation key: config.saved',
      ]),
    );
  });

  it('rejects missing client registrations instead of ignoring files or languages', async () => {
    const disk = (
      await inspectLocaleDirectory(root, { requireComplete: false })
    ).resources;
    expect(inspectLocaleInventory(disk, disk)).toEqual([]);
    expect(
      inspectLocaleInventory(disk, { zh: {}, en: disk['en'] ?? {} }),
    ).toEqual(['Locale module/registration mismatch: zh/config.json']);
    expect(inspectLocaleInventory({ ...disk, fr: {} }, disk)).toEqual([
      'Locale directory/registration mismatch: fr',
    ]);
  });
});
