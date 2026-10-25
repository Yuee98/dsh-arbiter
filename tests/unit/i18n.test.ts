import { describe, expect, test } from 'vitest';

import chinese from '../../locale/zh.json' with { type: 'json' };
import english from '../../locale/en.json' with { type: 'json' };
import { createArbiterI18n } from '../../src/client/i18n.js';
import { inspectCatalog } from '../../src/client/i18n/catalog.js';
import { createTestLocale } from '../helpers/test-locale.js';

describe('locale catalog contract', () => {
  test('checked-in catalogs meet the development contract', () => {
    expect(
      inspectCatalog(chinese, english, { requireComplete: false }),
    ).toEqual([]);
  });

  test('release validation rejects a missing English key that development permits', () => {
    const zh = { 'config.saved': '已保存 {count}' };
    expect(inspectCatalog(zh, {}, { requireComplete: false })).toEqual([]);
    expect(inspectCatalog(zh, {}, { requireComplete: true })).toEqual([
      'Missing English translation: config.saved',
    ]);
  });

  test('rejects mismatched placeholders, unknown keys, empty text and nonsemantic keys', () => {
    expect(
      inspectCatalog(
        { 'config.saved': '已保存 {count}', 'config.empty': '', 中文: '文案' },
        { 'config.saved': 'Saved {total}', 'unknown.key': 'Unexpected' },
        { requireComplete: false },
      ),
    ).toEqual([
      'Translation placeholders differ: config.saved',
      'Empty Chinese translation: config.empty',
      'Invalid semantic key: 中文',
      'Unknown English key: unknown.key',
    ]);
  });

  test('registers host dictionaries, interpolates opaque values and disposes owned dictionary', () => {
    const locale = createTestLocale('en');
    const i18n = createArbiterI18n(locale);
    expect(i18n.translate('summary')).toBe(english.summary);
    expect(
      i18n.translate('config.loadFailed', { error: '<untrusted> {another}' }),
    ).toBe('无法读取 Arbiter 配置：<untrusted> {another}');
    i18n.dispose();
    expect(i18n.translate('config.save')).toBe('config.save');
  });
});
