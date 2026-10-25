import { describe, expect, test } from 'vitest';

import {
  assess,
  eachItem,
  OFFICIAL_AUTO_REVIEW_MODULE,
  readObservation,
} from '../../src/host/coexistence-detect.js';
import type {
  CoexistenceObservation,
  ObservedHook,
  ProviderEntry,
} from '../../src/host/coexistence-detect.js';

/**
 * Detection is the whole claim of this feature: which provider blocks a
 * takeover, which only warns, and what "we could not see" means. These cases pin
 * the four answers the issue requires — official conflict, other listeners, no
 * conflict, and insufficient public information.
 */

function entry(
  moduleName: string,
  options: Partial<ProviderEntry> = {},
): ProviderEntry {
  return {
    entryId: options.entryId ?? moduleName,
    moduleName,
    enabled: options.enabled ?? true,
    phase: options.phase ?? 'active',
    injects: options.injects ?? [],
  };
}

function hook(
  event: ObservedHook['event'],
  options: Partial<ObservedHook> = {},
): ObservedHook {
  return {
    event,
    entryId: options.entryId ?? 'third-party',
    moduleName: options.moduleName ?? 'third-party-plugin',
    prepend: options.prepend ?? false,
    global: options.global ?? false,
    approvalRelated: options.approvalRelated ?? true,
  };
}

function observation(
  overrides: Partial<CoexistenceObservation> = {},
): CoexistenceObservation {
  return {
    entries: [],
    hooks: [],
    missing: [],
    autoSlot: 'arbiter',
    autoError: null,
    ...overrides,
  };
}

describe('official Auto Review detection', () => {
  test('an active official plugin blocks a takeover with one blocking conflict', () => {
    const result = assess(
      observation({ entries: [entry(OFFICIAL_AUTO_REVIEW_MODULE)] }),
    );
    expect(result.blocked).toBe(true);
    expect(result.detection).toBe('complete');
    expect(result.official).toMatchObject({
      present: true,
      enabled: true,
      running: true,
      phase: 'active',
    });
    expect(result.conflicts).toEqual([
      {
        id: 'official-auto-review',
        severity: 'blocking',
        kind: 'official-auto-review',
        source: OFFICIAL_AUTO_REVIEW_MODULE,
        entryId: OFFICIAL_AUTO_REVIEW_MODULE,
        capability: 'permissionPresets.auto',
        detail: null,
      },
    ]);
  });

  test.each([
    ['disabled entry', { enabled: false }],
    ['failed load', { phase: 'failed' as const }],
    ['still loading', { phase: 'loading' as const }],
    ['pending', { phase: 'pending' as const }],
  ])(
    'an installed but not-running official plugin (%s) does not block',
    (_label, options) => {
      const result = assess(
        observation({
          entries: [entry(OFFICIAL_AUTO_REVIEW_MODULE, options)],
        }),
      );
      expect(result.official.present).toBe(true);
      expect(result.official.running).toBe(false);
      expect(result.blocked).toBe(false);
      expect(result.conflicts).toEqual([]);
    },
  );

  test('a saved configuration without a loaded plugin is not a conflict at all', () => {
    // Nothing in the Loader tree: the profile may still list the bundle, but
    // this runtime never loaded it, which is exactly what the contract says not
    // to read from disk alone.
    const result = assess(observation());
    expect(result.official).toMatchObject({ present: false, running: false });
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  test('a deliberate warning-only auto slot stays a warning, not a block', () => {
    const result = assess(
      observation({ autoSlot: 'other', autoError: 'already registered' }),
    );
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([
      {
        id: 'auto-slot',
        severity: 'warning',
        kind: 'auto-slot',
        source: 'auto',
        entryId: null,
        capability: 'permissionPresets.auto',
        detail: 'already registered',
      },
    ]);
  });
});

describe('other approval listeners', () => {
  test('an approval-capable pre-execute listener warns without blocking', () => {
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'other-gate',
            moduleName: 'some-approval-plugin',
            prepend: true,
          }),
        ],
      }),
    );
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([
      {
        id: 'hook:other-gate:tools/pre-execute',
        severity: 'warning',
        kind: 'approval-hook',
        source: 'some-approval-plugin',
        entryId: 'other-gate',
        capability: 'tools/pre-execute',
        detail: 'prepend',
      },
    ]);
  });

  test('a plain listener without approval capability is not a conflict', () => {
    // A host guard narrows execution; it is not a competing approval provider,
    // so it must not appear as a conflict even though it runs on the same hook.
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'guard',
            moduleName: 'a-host-guard',
            approvalRelated: false,
          }),
        ],
      }),
    );
    expect(result.conflicts).toEqual([]);
    expect(result.blocked).toBe(false);
  });

  test('two capabilities of one owner are two rows, a repeat is one', () => {
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', { entryId: 'x', moduleName: 'x-plugin' }),
          hook('tools/pre-execute', { entryId: 'x', moduleName: 'x-plugin' }),
          hook('approval/request', { entryId: 'x', moduleName: 'x-plugin' }),
        ],
      }),
    );
    expect(result.conflicts.map((item) => item.id)).toEqual([
      'hook:x:tools/pre-execute',
      'hook:x:approval/request',
    ]);
    expect(result.conflicts.every((item) => item.severity === 'warning')).toBe(
      true,
    );
  });

  test('official running and third-party warnings coexist with distinct severities', () => {
    const result = assess(
      observation({
        entries: [entry(OFFICIAL_AUTO_REVIEW_MODULE)],
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'other',
            moduleName: 'other-plugin',
          }),
        ],
        autoSlot: 'other',
      }),
    );
    expect(result.blocked).toBe(true);
    expect(result.conflicts.map((item) => [item.kind, item.severity])).toEqual([
      ['official-auto-review', 'blocking'],
      ['auto-slot', 'warning'],
      ['approval-hook', 'warning'],
    ]);
  });
});

describe('insufficient public information', () => {
  test('a missing loader surface reports partial detection instead of "clean"', () => {
    const result = assess(
      readObservation({
        loader: { entries: 1 },
        events: { _hooks: {} },
        selfFiber: undefined,
        autoSlot: 'arbiter',
        autoError: null,
      }),
    );
    expect(result.detection).toBe('partial');
    expect(result.missing).toEqual(['loader']);
    // Incomplete evidence is never reported as a verified absence.
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  test('a missing event-bus surface reports partial detection instead of "clean"', () => {
    const result = assess(
      readObservation({
        loader: { entries: () => [] },
        events: {},
        selfFiber: undefined,
        autoSlot: 'arbiter',
        autoError: null,
      }),
    );
    expect(result.detection).toBe('partial');
    expect(result.missing).toEqual(['events']);
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  test('a host with neither surface reports both as missing', () => {
    const result = assess(
      readObservation({
        loader: undefined,
        events: undefined,
        selfFiber: undefined,
        autoSlot: 'unknown',
        autoError: null,
      }),
    );
    expect(result.detection).toBe('partial');
    expect(result.missing).toEqual(['loader', 'events']);
  });

  test('a structure the reader cannot walk is reported, not guessed', () => {
    const result = assess(
      readObservation({
        // `entries()` must be callable; a plain property is unreadable.
        loader: { entries: 42 },
        events: { _hooks: { 'tools/pre-execute': 42 } },
        selfFiber: undefined,
        autoSlot: 'arbiter',
        autoError: null,
      }),
    );
    expect(result.detection).toBe('partial');
    expect(result.missing).toEqual(['loader']);
    // The event list itself was walkable, so that surface stays readable.
    expect(result.observedHooks).toEqual([]);
  });
});

describe('structural reader', () => {
  test('walks a generator without materializing it', () => {
    const seen: unknown[] = [];
    function* source(): Generator<number> {
      yield 1;
      yield 2;
    }
    expect(
      eachItem(source(), (item) => {
        seen.push(item);
      }),
    ).toBe(true);
    expect(seen).toEqual([1, 2]);
  });

  test('rejects non-iterable values and stops on done', () => {
    expect(eachItem({}, () => undefined)).toBe(false);
    expect(eachItem(null, () => undefined)).toBe(false);
    let count = 0;
    const iterator = {
      [Symbol.iterator]() {
        return {
          next: () => ({ done: true, value: null }),
        };
      },
    };
    expect(
      eachItem(iterator, () => {
        count += 1;
      }),
    ).toBe(true);
    expect(count).toBe(0);
  });

  test('reads the host entry and hook shapes the loader actually exposes', () => {
    const selfFiber = { name: 'arbiter', state: 2, entry: null };
    const entries = [
      {
        id: 'official',
        options: {
          name: OFFICIAL_AUTO_REVIEW_MODULE,
          inject: ['approval', 'permissionPresets'],
        },
        fiber: { state: 2 },
      },
      { id: 'group', options: { group: true } },
      {
        id: 'disabled',
        options: { name: 'off-plugin', disabled: true },
        fiber: { state: 1 },
      },
    ];
    const hooks = {
      'tools/pre-execute': [
        {
          ctx: { fiber: selfFiber },
          callback: () => undefined,
          prepend: true,
        },
        {
          ctx: {
            fiber: {
              state: 2,
              inject: { approval: true },
              entry: { id: 'other', options: { name: 'other-gate' } },
            },
          },
          callback: () => undefined,
        },
        {
          ctx: {
            fiber: {
              state: 2,
              inject: { tools: true },
              entry: { id: 'guard', options: { name: 'host-guard' } },
            },
          },
          callback: () => undefined,
        },
      ],
    };
    const result = assess(
      readObservation({
        loader: { entries: () => entries },
        events: { _hooks: hooks },
        selfFiber,
        autoSlot: 'arbiter',
        autoError: null,
      }),
    );
    expect(result.detection).toBe('complete');
    expect(result.blocked).toBe(true);
    // Arbiter's own gate is excluded; the guard has no approval capability.
    expect(result.observedHooks).toHaveLength(2);
    expect(result.conflicts.map((item) => item.id)).toEqual([
      'official-auto-review',
      'hook:other:tools/pre-execute',
    ]);
  });
});

describe('official provider is named once', () => {
  test('the official plugin is not repeated as a generic listener row', () => {
    const result = assess(
      observation({
        entries: [entry(OFFICIAL_AUTO_REVIEW_MODULE)],
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'auto-review',
            moduleName: OFFICIAL_AUTO_REVIEW_MODULE,
          }),
        ],
      }),
    );
    expect(result.conflicts).toHaveLength(1);
    expect(result.conflicts[0]?.kind).toBe('official-auto-review');
  });
});
