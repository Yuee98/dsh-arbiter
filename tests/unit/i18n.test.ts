import { describe, expect, expectTypeOf, test } from 'vitest';

import { createArbiterI18n } from '../../src/client/i18n.js';
import type { TranslationKey } from '../../src/client/i18n.js';
import {
  createLocaleCatalogs,
  flattenCatalog,
  inspectCatalog,
} from '../../src/client/i18n/catalog.js';
import { localeResources } from '../../src/client/i18n/resources.js';
import { createTestLocale } from '../helpers/test-locale.js';

describe('locale catalog contract', () => {
  test('checked-in catalogs meet the development contract', () => {
    expect(
      inspectCatalog(localeResources.zh, localeResources.en, {
        language: 'en',
        requireComplete: false,
      }),
    ).toEqual([]);
  });

  test('release validation rejects a missing English key that development permits', () => {
    const zh = { config: { saved: '已保存 {count}' } };
    expect(
      inspectCatalog(zh, {}, { language: 'fr', requireComplete: false }),
    ).toEqual([]);
    expect(
      inspectCatalog(zh, {}, { language: 'fr', requireComplete: true }),
    ).toEqual(['Missing fr translation: config.saved']);
  });

  test('rejects mismatched placeholders, unknown branches and object/string conflicts in any language', () => {
    expect(
      inspectCatalog(
        { config: { saved: '已保存 {count}', actions: { save: '保存' } } },
        {
          config: { saved: 'Saved {total}', actions: 'Save', unknown: {} },
          extra: {},
        },
        { language: 'de', requireComplete: false },
      ),
    ).toEqual([
      'Translation placeholders differ (de): config.saved',
      'Translation object/string conflict (de): config.actions',
      'Unknown de key: config.unknown',
      'Unknown de module: extra',
    ]);
  });

  test('registers host dictionaries, interpolates opaque values and disposes owned dictionary', () => {
    const locale = createTestLocale('en');
    const i18n = createArbiterI18n(locale);
    expect(i18n.translate('summary')).toBe(localeResources.en.common.summary);
    expect(
      i18n.translate('config.loadFailed', { error: '<untrusted> {another}' }),
    ).toBe('无法读取 Arbiter 配置：<untrusted> {another}');
    i18n.dispose();
    expect(i18n.translate('config.save')).toBe('config.save');
  });

  test('retains dotted leaf types and excludes module or object paths', () => {
    expectTypeOf<'config.actions.label'>().toExtend<TranslationKey>();
    expectTypeOf<TranslationKey>()
      .extract<'config' | 'config.actions' | 'config.missing'>()
      .toBeNever();
    expect(flattenCatalog(localeResources.zh)['config.actions.label']).toBe(
      '配置操作',
    );
  });

  test('falls back per leaf and per missing module without replacing a nested group', () => {
    const catalogs = createLocaleCatalogs({
      zh: {
        config: { actions: { save: '保存', cancel: '取消' } },
        logs: { title: '日志' },
      },
      en: { config: { actions: { save: 'Save' } } },
      fr: {},
    });
    expect(catalogs['en']).toEqual({
      'config.actions.save': 'Save',
      'config.actions.cancel': '取消',
      'logs.title': '日志',
    });
    expect(catalogs['fr']).toEqual({
      'config.actions.save': '保存',
      'config.actions.cancel': '取消',
      'logs.title': '日志',
    });
  });

  test('rejects namespace collisions instead of silently overwriting messages', () => {
    expect(() =>
      flattenCatalog({
        common: { config: { save: 'A' } },
        config: { save: 'B' },
      }),
    ).toThrow('Duplicate translation key: config.save');
    expect(() =>
      flattenCatalog({ common: { config: 'A' }, config: { save: 'B' } }),
    ).toThrow('Translation object/string conflict: config');
    expect(() => createLocaleCatalogs({ en: {} })).toThrow(
      'Missing source locale: zh',
    );
  });
});
