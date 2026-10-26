import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { CoexistenceMonitor } from '../../src/host/coexistence.js';
import { OFFICIAL_AUTO_REVIEW_MODULE } from '../../src/host/coexistence-detect.js';
import { initializeHost } from '../../src/host/runtime.js';
import type { AutoSlot } from '../../src/host/coexistence-detect.js';
import { createStubContext } from '../helpers/host-stub.js';

/**
 * The monitor turns one observation into notices. The contract it must keep:
 * one reminder per continuous conflict period, acknowledgement is "read" and
 * never "resolved", and a reappearing conflict is a new period.
 */

const homes: string[] = [];
let previousHome: string | undefined;

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-coexistence-'));
  homes.push(home);
  process.env['DSH_HOME'] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = previousHome;
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

interface Harness {
  readonly monitor: CoexistenceMonitor;
  /** Replace what the hosts' public surfaces report. */
  readonly setOfficial: (phase: 'active' | 'failed' | null) => void;
  readonly setAutoSlot: (slot: AutoSlot) => void;
  /** `other` is a foreign approval-capable listener; `self` is Arbiter's own. */
  readonly setHooks: (owner: 'other' | 'self' | null) => void;
  readonly setLoaderReadable: (readable: boolean) => void;
}

function harness(options: { readonly selfFiber?: unknown } = {}): Harness {
  let official: 'active' | 'failed' | null = null;
  let hooks: 'other' | 'self' | null = null;
  let slot: AutoSlot = 'arbiter';
  let loaderReadable = true;
  const hostFiber = options.selfFiber ?? { name: 'arbiter' };
  const loader = {
    *entries() {
      if (!loaderReadable) throw new Error('loader unavailable');
      if (official === null) return;
      yield {
        id: 'auto-review',
        options: { name: OFFICIAL_AUTO_REVIEW_MODULE },
        fiber: { state: official === 'active' ? 2 : 3 },
      };
    },
  };
  const foreignFiber = {
    name: 'other',
    state: 2,
    inject: { approval: true },
    entry: { id: 'other', options: { name: 'other-approval-plugin' } },
  };
  const events = {
    get _hooks() {
      if (hooks === null) return {};
      // The host's own listener record carries the owning context, so identity
      // is what distinguishes this plugin's gate from a competing one.
      // Identity is the discriminator, so the same object must be reused.
      const fiber = hooks === 'self' ? hostFiber : foreignFiber;
      return {
        'tools/pre-execute': [{ ctx: { fiber }, callback: () => undefined }],
      };
    },
  };
  const parts = createStubContext({
    profileContext: {
      home: process.env['DSH_HOME'] ?? '',
      dir: process.env['DSH_HOME'] ?? '',
      name: 'coexistence-test',
    },
    loader,
  });
  // The stub serves the Loader and the profile; the event bus and this plugin's
  // own fiber are the two extra surfaces coexistence reads.
  const ctx = {
    ...parts.ctx,
    events,
    fiber: hostFiber,
  };
  const host = initializeHost(ctx, {});
  const monitor = new CoexistenceMonitor(host, {
    autoSlot: () => slot,
    autoError: () => null,
    selfFiber: hostFiber,
  });
  return {
    monitor,
    setOfficial: (next) => {
      official = next;
    },
    setAutoSlot: (next) => {
      slot = next;
    },
    setHooks: (owner) => {
      hooks = owner;
    },
    setLoaderReadable: (readable) => {
      loaderReadable = readable;
    },
  };
}

describe('one reminder per continuous conflict period', () => {
  test('a stable conflict opens one notice and never re-notifies', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const first = test_.monitor.read('first');
    expect(first.notices).toHaveLength(1);
    expect(first.notices[0]).toMatchObject({
      conflictId: 'official-auto-review',
      severity: 'blocking',
      acknowledged: false,
    });
    const second = test_.monitor.read('second');
    const third = test_.monitor.read('third');
    expect(second.notices).toHaveLength(1);
    expect(third.notices).toHaveLength(1);
    // Same continuous period keeps the same notice identity.
    expect(third.notices[0]?.id).toBe(first.notices[0]?.id);
  });

  test('acknowledgement marks the notice read without clearing the conflict', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const before = test_.monitor.read('first');
    const id = before.notices[0]?.id ?? '';
    const after = test_.monitor.acknowledge([id]);
    expect(after.notices[0]?.acknowledged).toBe(true);
    // The conflict, the block and the reason survive the acknowledgement.
    expect(after.conflicts).toHaveLength(1);
    expect(after.blocked).toBe(true);
    expect(after.reason).toBe('official-running');
    expect(test_.monitor.enableBlock()).not.toBeNull();
  });

  test('an acknowledged period does not re-open while it persists', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const id = test_.monitor.read('first').notices[0]?.id ?? '';
    test_.monitor.acknowledge([id]);
    expect(test_.monitor.read('later').notices).toHaveLength(1);
    expect(test_.monitor.read('later').notices[0]?.acknowledged).toBe(true);
  });

  test('a conflict that disappears and returns is a new period with a new notice', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const first = test_.monitor.read('first');
    test_.monitor.acknowledge([first.notices[0]?.id ?? '']);
    // The official plugin is turned off: the period ends.
    test_.setOfficial(null);
    expect(test_.monitor.read('stopped').conflicts).toEqual([]);
    expect(test_.monitor.read('stopped').blocked).toBe(false);
    // Turning it back on starts a new period, which earns a fresh reminder.
    test_.setOfficial('active');
    const returned = test_.monitor.read('returned');
    expect(returned.notices).toHaveLength(2);
    expect(returned.notices.at(-1)).toMatchObject({
      acknowledged: false,
      conflictId: 'official-auto-review',
    });
    expect(returned.notices.at(-1)?.id).not.toBe(first.notices[0]?.id);
  });

  test('a new warning among existing conflicts opens only its own notice', () => {
    const test_ = harness();
    test_.setOfficial('active');
    test_.monitor.read('official');
    test_.setHooks('other');
    const withHook = test_.monitor.read('hook');
    expect(withHook.notices).toHaveLength(2);
    expect(withHook.notices.map((notice) => notice.conflictId)).toEqual([
      'official-auto-review',
      'hook:other:tools/pre-execute',
    ]);
  });

  test('unknown notice ids are ignored and bounded', () => {
    const test_ = harness();
    test_.setOfficial('active');
    test_.monitor.read('first');
    const after = test_.monitor.acknowledge(['does-not-exist']);
    expect(after.notices[0]?.acknowledged).toBe(false);
  });
});

describe('the enable guard', () => {
  test('reports the exact official source and the way out', () => {
    const test_ = harness();
    test_.setOfficial('active');
    expect(test_.monitor.enableBlock()).toMatchObject({
      code: 'coexistence-blocked',
      detail: {
        reason: 'official-running',
        source: OFFICIAL_AUTO_REVIEW_MODULE,
        entryId: 'auto-review',
        guidance: 'disable-official-auto-review',
      },
    });
  });

  test('allows a takeover when the official plugin merely installed', () => {
    const test_ = harness();
    test_.setOfficial('failed');
    expect(test_.monitor.enableBlock()).toBeNull();
  });

  test('allows a takeover when another listener only warns', () => {
    const test_ = harness();
    test_.setHooks('other');
    expect(test_.monitor.enableBlock()).toBeNull();
    expect(test_.monitor.read('hook').conflicts).toHaveLength(1);
  });

  test('reads the host again on every call instead of caching startup', () => {
    const test_ = harness();
    expect(test_.monitor.enableBlock()).toBeNull();
    test_.setOfficial('active');
    expect(test_.monitor.enableBlock()).not.toBeNull();
    test_.setOfficial(null);
    expect(test_.monitor.enableBlock()).toBeNull();
  });

  test('excludes this plugin own listener from the competing set', () => {
    const test_ = harness();
    test_.setHooks('self');
    const view = test_.monitor.read('own');
    expect(view.conflicts).toEqual([]);
    expect(view.blocked).toBe(false);
  });
});

describe('host-side observation without a client', () => {
  test('the monitor observes on its own schedule and records the transition once', async () => {
    const test_ = harness();
    const stop = test_.monitor.start(10);
    try {
      // No page and no request: the interval alone must see the conflict.
      expect(test_.monitor.read('idle').observations).toBeGreaterThan(0);
      test_.setOfficial('active');
      await new Promise((resolve) => setTimeout(resolve, 40));
      const observed = test_.monitor.read('after');
      expect(observed.notices).toHaveLength(1);
      expect(observed.blocked).toBe(true);
      // The interval keeps observing but never opens a second notice.
      await new Promise((resolve) => setTimeout(resolve, 40));
      expect(test_.monitor.read('later').notices).toHaveLength(1);
    } finally {
      stop();
    }
  });

  test('stopping the observation leaves the last confirmed state readable', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const stop = test_.monitor.start(10_000);
    stop();
    const view = test_.monitor.read('after-stop');
    expect(view.blocked).toBe(true);
    expect(view.notices).toHaveLength(1);
  });
});

describe('resolving a conflict still reports the Auto-slot capability', () => {
  test('a cleared official conflict does not hide a failed registration', () => {
    const test_ = harness();
    test_.setAutoSlot('other');
    const other = test_.monitor.read('other');
    expect(other.blocked).toBe(false);
    expect(other.autoSlotProblem).toMatchObject({
      kind: 'registration-failed',
      recovery: 'reload-plugin',
    });
    // A host without the slot is a different, also unresolved fact.
    test_.setAutoSlot('unknown');
    expect(test_.monitor.read('unknown').autoSlotProblem).toMatchObject({
      kind: 'slot-unavailable',
    });
    test_.setAutoSlot('arbiter');
    expect(test_.monitor.read('arbiter').autoSlotProblem).toBeNull();
  });
});

describe('period lifecycle across an unreadable surface', () => {
  test('a temporarily unreadable loader does not end the official period', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const first = test_.monitor.read('active');
    test_.monitor.acknowledge([first.notices[0]?.id ?? '']);
    // The Loader read fails for one observation; the provider never stopped.
    test_.setLoaderReadable(false);
    const blind = test_.monitor.read('blind');
    expect(blind.detection).toBe('partial');
    expect(blind.notices).toHaveLength(1);
    expect(blind.notices[0]?.acknowledged).toBe(true);
    // The surface returns; the same period must not earn a new reminder.
    test_.setLoaderReadable(true);
    const back = test_.monitor.read('back');
    expect(back.notices).toHaveLength(1);
    expect(back.notices[0]?.acknowledged).toBe(true);
    expect(back.blocked).toBe(true);
  });

  test('a conflict confirmed absent on complete observation ends its period', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const first = test_.monitor.read('active');
    test_.monitor.acknowledge([first.notices[0]?.id ?? '']);
    test_.setOfficial(null);
    const cleared = test_.monitor.read('cleared');
    expect(cleared.conflicts).toEqual([]);
    test_.setOfficial('active');
    const again = test_.monitor.read('again');
    // A genuinely new period earns a fresh reminder.
    expect(again.notices).toHaveLength(2);
    expect(again.notices.at(-1)?.acknowledged).toBe(false);
  });

  test('a resolved conflict never raises a stale blocking reminder', () => {
    const test_ = harness();
    test_.setOfficial('active');
    const active = test_.monitor.read('active');
    expect(active.notices[0]?.acknowledged).toBe(false);
    test_.setOfficial(null);
    const resolved = test_.monitor.read('resolved');
    // The history is retained, but it can no longer drive a dialog.
    expect(resolved.notices).toHaveLength(1);
    expect(resolved.notices[0]?.acknowledged).toBe(true);
    expect(resolved.conflicts).toEqual([]);
  });
});
