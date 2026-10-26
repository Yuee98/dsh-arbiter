import { describe, expect, test, vi } from 'vitest';

import { claimWhenPresent } from '../../src/client/permission-slot-claim.js';

/** Let the pending promise chain settle. */
async function settle(): Promise<void> {
  for (let index = 0; index < 6; index += 1) await Promise.resolve();
}

describe('permission seat claim', () => {
  test('claims once the host half answers', async () => {
    const claim = vi.fn(() => () => undefined);
    const release = claimWhenPresent({
      present: () => Promise.resolve(true),
      claim,
      subscribe: () => () => undefined,
    });
    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    release();
  });

  test('does not claim while the host half is absent', async () => {
    const claim = vi.fn(() => () => undefined);
    const release = claimWhenPresent({
      present: () => Promise.resolve(false),
      claim,
      subscribe: () => () => undefined,
    });
    await settle();
    expect(claim).not.toHaveBeenCalled();
    release();
  });

  test('retries after a recovered connection, and claims then', async () => {
    const signals: (() => void)[] = [];
    const retry = (): void => {
      signals[0]?.();
    };
    let present = false;
    const claim = vi.fn(() => () => undefined);
    const release = claimWhenPresent({
      present: () => Promise.resolve(present),
      claim,
      subscribe: (signal) => {
        signals.push(signal);
        return () => undefined;
      },
    });
    await settle();
    expect(claim).not.toHaveBeenCalled();

    // The host half becomes reachable and the connection is re-established.
    present = true;
    retry();
    await settle();
    expect(claim).toHaveBeenCalledTimes(1);

    // A second recovery must not register the seat twice.
    retry();
    await settle();
    expect(claim).toHaveBeenCalledTimes(1);
    release();
  });

  test('honours a recovery signal that arrives while a probe is running', async () => {
    const signals: (() => void)[] = [];
    const answers: boolean[] = [false, true];
    let reads = 0;
    const claim = vi.fn(() => () => undefined);
    const release = claimWhenPresent({
      present: () => {
        const answer = answers[reads] ?? true;
        reads += 1;
        return Promise.resolve(answer);
      },
      claim,
      subscribe: (signal) => {
        signals.push(signal);
        return () => undefined;
      },
    });
    signals[0]?.();
    await settle();
    expect(reads).toBe(2);
    expect(claim).toHaveBeenCalledTimes(1);
    release();
  });

  test('release disposes the claim and stops listening', async () => {
    const dispose = vi.fn();
    const unsubscribe = vi.fn();
    const release = claimWhenPresent({
      present: () => Promise.resolve(true),
      claim: () => dispose,
      subscribe: () => unsubscribe,
    });
    await settle();
    release();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});
