import { describe, expect, test } from 'vitest';

import {
  assess,
  OFFICIAL_AUTO_REVIEW_MODULE,
  readObservation,
  walkItems,
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
    injects: options.injects ?? ['tools'],
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
    ['stopped after disable', { enabled: false, phase: 'disposed' as const }],
    [
      'registered but not loaded',
      { enabled: false, phase: 'unknown' as const },
    ],
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

  test('a saved disabled flag over a still-active fiber still blocks', () => {
    // The contract forbids concluding "stopped" from the saved switch: only the
    // live fiber state proves the provider is no longer running.
    const result = assess(
      observation({
        entries: [entry(OFFICIAL_AUTO_REVIEW_MODULE, { enabled: false })],
      }),
    );
    expect(result.official).toMatchObject({
      present: true,
      enabled: false,
      running: true,
      phase: 'active',
    });
    expect(result.blocked).toBe(true);
  });

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

  test('a plain listener without approval services is still a capability warning', () => {
    // `tools/pre-execute` can itself decide whether a call proceeds, so a
    // listener that injects only `tools` is a possible competing provider. The
    // warning reports the capability it was seen using, never a decision.
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'tools-only',
            moduleName: 'tools-only-reviewer',
            injects: ['tools'],
          }),
        ],
      }),
    );
    expect(result.blocked).toBe(false);
    expect(result.conflicts).toEqual([
      {
        id: 'hook:tools-only:tools/pre-execute',
        severity: 'warning',
        kind: 'approval-hook',
        source: 'tools-only-reviewer',
        entryId: 'tools-only',
        capability: 'tools/pre-execute',
        detail: null,
      },
    ]);
  });

  test('a host guard is not a listener and therefore not a conflict', () => {
    // `tools.guard()` stores its checks in a separate monotonic list, so a
    // guard never appears among these hooks. An empty observation is the honest
    // answer, not a fabricated provider row.
    const result = assess(observation({ hooks: [] }));
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
    // Both surfaces are genuinely unreadable: the loader has no callable
    // `entries`, and the listener list is not a collection. Reporting only one
    // would let the caller trust the other.
    expect(result.missing).toEqual(['loader', 'events']);
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
      walkItems(source(), (item) => {
        seen.push(item);
      }),
    ).toBe('complete');
    expect(seen).toEqual([1, 2]);
  });

  test('rejects non-iterable values and stops on done', () => {
    expect(walkItems({}, () => undefined)).toBe('unreadable');
    expect(walkItems(null, () => undefined)).toBe('unreadable');
    let count = 0;
    const iterator = {
      [Symbol.iterator]() {
        return {
          next: () => ({ done: true, value: null }),
        };
      },
    };
    expect(
      walkItems(iterator, () => {
        count += 1;
      }),
    ).toBe('complete');
    expect(count).toBe(0);
  });

  test('reports a throwing iterator instead of propagating it', () => {
    const hostile = {
      [Symbol.iterator]() {
        return {
          next: () => {
            throw new Error('host inventory exploded');
          },
        };
      },
    };
    expect(walkItems(hostile, () => undefined)).toBe('failed');
  });

  test('reports truncation rather than claiming a complete inventory', () => {
    const many = Array.from({ length: 600 }, (_value, index) => index);
    let visited = 0;
    expect(
      walkItems(many, () => {
        visited += 1;
      }),
    ).toBe('truncated');
    expect(visited).toBe(512);
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
    // Arbiter's own gate is excluded; both foreign pre-execute listeners are
    // capabilities the host allows to change a decision, so both warn.
    expect(result.observedHooks).toHaveLength(2);
    expect(result.conflicts.map((item) => item.id)).toEqual([
      'official-auto-review',
      'hook:other:tools/pre-execute',
      'hook:guard:tools/pre-execute',
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

describe('provenance, not a plugin list', () => {
  test('a host-shipped listener is an execution constraint, not a provider', () => {
    // The host's own tools contribute pre-execute listeners; keeping them
    // working is assumed by the contract, so they are not warnings.
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'tool-jobs',
            moduleName: '@deepseek-ai/dsh-tool-jobs',
          }),
          hook('tools/pre-execute', {
            entryId: 'workspace-changes',
            moduleName: '@deepseek-ai/dsh-workspace-changes',
          }),
        ],
      }),
    );
    expect(result.conflicts).toEqual([]);
  });

  test('any non-host listener with the capability warns, with no named package', () => {
    const result = assess(
      observation({
        hooks: [
          hook('tools/pre-execute', {
            entryId: 'acme',
            moduleName: 'acme-permissions',
          }),
          hook('approval/request', {
            entryId: 'beta',
            moduleName: 'beta-reviewer',
          }),
        ],
      }),
    );
    expect(result.conflicts.map((conflict) => conflict.source)).toEqual([
      'acme-permissions',
      'beta-reviewer',
    ]);
    // The detector carries no list to enumerate; the rows are the observation.
    expect(result.conflicts.every((item) => item.severity === 'warning')).toBe(
      true,
    );
  });

  test('an owner that cannot be identified is still reported honestly', () => {
    // A hook whose owning context is unavailable has no module name; the row
    // says so rather than inventing a package identity.
    const result = assess(
      observation({
        hooks: [
          {
            event: 'tools/pre-execute',
            entryId: null,
            moduleName: null,
            prepend: false,
            global: false,
            injects: [],
          },
        ],
      }),
    );
    expect(result.conflicts).toEqual([
      {
        id: 'hook:unknown:tools/pre-execute',
        severity: 'warning',
        kind: 'approval-hook',
        source: 'unknown',
        entryId: null,
        capability: 'tools/pre-execute',
        detail: null,
      },
    ]);
  });
});

describe('a duplicate official entry does not hide the running one', () => {
  test('an active copy behind a disabled one still blocks', () => {
    // A profile can hold a stale disabled row before the live one; selecting the
    // first match would report "not running" and allow a takeover.
    const result = assess(
      observation({
        entries: [
          entry(OFFICIAL_AUTO_REVIEW_MODULE, {
            entryId: 'auto-review-stale',
            enabled: false,
            phase: 'disposed',
          }),
          entry(OFFICIAL_AUTO_REVIEW_MODULE, { entryId: 'auto-review-live' }),
        ],
      }),
    );
    expect(result.official).toMatchObject({ running: true, phase: 'active' });
    expect(result.blocked).toBe(true);
    expect(result.conflicts[0]).toMatchObject({
      id: 'official-auto-review',
      entryId: 'auto-review-live',
    });
  });
});
