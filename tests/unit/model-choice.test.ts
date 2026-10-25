import { describe, expect, test } from 'vitest';

import {
  SESSION_CHOICE,
  catalogueOptions,
  choiceInGroups,
  decodeChoice,
  encodeChoice,
  filterModelGroups,
  isSessionChoice,
} from '../../src/client/model-choice.js';
import type { ModelGroupView } from '../../src/client/view-types.js';

const groups: readonly ModelGroupView[] = [
  {
    id: 'deepseek-official',
    name: 'DeepSeek',
    models: [
      { id: 'deepseek-flash', name: 'DeepSeek-V4.1-Flash' },
      { id: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro' },
    ],
  },
  {
    id: 'gateway',
    name: 'Internal gateway',
    models: [
      { id: 'shared-model', name: 'Shared model' },
      { id: 'claude', name: 'Claude' },
    ],
  },
  {
    id: 'second-gateway',
    name: 'Second gateway',
    models: [{ id: 'shared-model', name: 'Shared model' }],
  },
];

describe('reviewer model choice encoding', () => {
  test('the session route keeps its own stable value and empty model', () => {
    expect(isSessionChoice(SESSION_CHOICE)).toBe(true);
    expect(encodeChoice(SESSION_CHOICE)).toBe('session');
    expect(decodeChoice('session')).toEqual({
      provider: 'session',
      model: '',
    });
  });

  test('round-trips opaque provider and model ids without collapsing distinct pairs', () => {
    for (const choice of [
      { provider: 'deepseek-official', model: 'deepseek-flash' },
      { provider: 'a/b', model: 'c:d' },
      { provider: 'x', model: 'model with spaces' },
      { provider: 'x', model: 'line\nbreak' },
      { provider: 'x', model: 'quote"inside' },
    ]) {
      expect(decodeChoice(encodeChoice(choice))).toEqual(choice);
    }
    // A naive separator join would map both of these onto the same value.
    expect(encodeChoice({ provider: 'a/b', model: 'c' })).not.toBe(
      encodeChoice({ provider: 'a', model: 'b/c' }),
    );
  });

  test('rejects values that are not an encoded provider/model pair', () => {
    for (const raw of [
      '',
      'deepseek',
      '[]',
      '["only-provider"]',
      '["a","b","c"]',
      '[1,2]',
      '{"provider":"a","model":"b"}',
      '["","b"]',
      '["a",""]',
      '["session","model"]',
    ]) {
      expect(decodeChoice(raw)).toBeNull();
    }
  });

  test('the same model id under two providers stays two distinct options', () => {
    const options = catalogueOptions(groups).filter(
      (option) => option.model === 'shared-model',
    );
    expect(options).toHaveLength(2);
    expect(new Set(options.map((option) => encodeChoice(option))).size).toBe(2);
    expect(options.map((option) => option.providerName)).toEqual([
      'Internal gateway',
      'Second gateway',
    ]);
  });

  test('search narrows by provider and model, keeping full groups and dropping empties', () => {
    expect(filterModelGroups(groups, '')).toBe(groups);
    expect(
      filterModelGroups(groups, 'gateway').map((group) => group.id),
    ).toEqual(['gateway', 'second-gateway']);
    expect(filterModelGroups(groups, 'CLAUDE')).toEqual([
      {
        id: 'gateway',
        name: 'Internal gateway',
        models: [{ id: 'claude', name: 'Claude' }],
      },
    ]);
    // The display name is searchable too, not only the stored id.
    expect(
      filterModelGroups(groups, 'v4-pro').map((group) => group.models.length),
    ).toEqual([1]);
    expect(filterModelGroups(groups, 'nothing-matches')).toEqual([]);
    expect(filterModelGroups(groups, '   ')).toBe(groups);
  });

  test('reports whether a stored route is still offered by the catalog', () => {
    expect(
      choiceInGroups(groups, { provider: 'gateway', model: 'claude' }),
    ).toBe(true);
    expect(
      choiceInGroups(groups, { provider: 'gateway', model: 'deepseek-flash' }),
    ).toBe(false);
    expect(choiceInGroups(groups, SESSION_CHOICE)).toBe(false);
  });
});
