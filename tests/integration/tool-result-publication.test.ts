import type * as NodeFs from 'node:fs';
import type { PathLike } from 'node:fs';
import { readdirSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { resultFixture, resultObservation } from './tool-result-helpers.js';

const fault = vi.hoisted(() => ({ sync: false, rename: false }));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>();
  return {
    ...actual,
    fsyncSync(descriptor: number) {
      if (fault.sync) throw new Error('synthetic fsync failure');
      actual.fsyncSync(descriptor);
    },
    renameSync(before: PathLike, after: PathLike) {
      if (fault.rename) throw new Error('synthetic rename failure');
      actual.renameSync(before, after);
    },
  };
});
let fixture: ReturnType<typeof resultFixture>;
beforeEach(() => {
  fixture = resultFixture();
});
afterEach(() => {
  fault.sync = false;
  fault.rename = false;
  fixture.close();
});

describe('recoverable file publication fault boundaries', () => {
  test.each(['sync', 'rename'] as const)(
    '%s failure never exposes a complete result and the abandoned temporary is recovered',
    (stage) => {
      const store = fixture.open();
      fault[stage] = true;
      expect(
        store.saveToolResult(
          resultObservation({
            parts: [
              { kind: 'text', channel: 'stdout', text: 'safe'.repeat(20_000) },
            ],
          }),
        ).state,
      ).toBe('failed');
      expect(store.getToolResult('session', 'query').state).toBe(
        'storage-failed',
      );
      expect(store.health().state).toBe('degraded');
      expect(
        readdirSync(`${fixture.path}.results`).every((name) =>
          name.endsWith('.tmp'),
        ),
      ).toBe(true);
      fault[stage] = false;
      store.close();
      const restarted = fixture.open();
      expect(readdirSync(`${fixture.path}.results`)).toEqual([]);
      expect(restarted.getToolResult('session', 'query').state).toBe(
        'storage-failed',
      );
    },
  );
});
