import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { expect, test, vi } from 'vitest';
import { withWorkflowArea } from '../evals/helpers/workflow-run.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof fs>();
  return { ...actual, rename: vi.fn(actual.rename) };
});

test('an owned dispatch whose final index write fails still produces a truthful failed report', async () => {
  const actual = await vi.importActual<typeof fs>('node:fs/promises');
  await withWorkflowArea(async (area) => {
    await area.write();
    let failed = false;
    vi.mocked(fs.rename).mockImplementation(async (from, to) => {
      const records = await actual
        .readdir(join(area.runDirectory, 'records'))
        .catch(() => []);
      if (
        !failed &&
        to === join(area.runDirectory, 'index.json') &&
        records.length > 0
      ) {
        failed = true;
        throw new Error('synthetic failure publishing final index');
      }
      return actual.rename(from, to);
    });
    expect(await area.cli(['run', area.planPath, '--report'])).toBe(1);
    expect(failed).toBe(true);
    const value: unknown = JSON.parse(
      await fs.readFile(join(area.runDirectory, 'report.json'), 'utf8'),
    );
    expect(value).toHaveProperty('run.status', 'running');
    expect(value).toHaveProperty(
      'publication.consistency.indexReliable',
      false,
    );
    expect(value).toHaveProperty('coverage.records', 2);
    expect(value).toHaveProperty('examples.length', 2);
    expect(
      await fs.readFile(join(area.runDirectory, 'report.md'), 'utf8'),
    ).toContain('索引与持久化记录不一致');
  });
}, 30_000);
