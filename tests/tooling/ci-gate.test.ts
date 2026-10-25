import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const gate = fileURLToPath(
  new URL('../../tooling/ci/check-results.mjs', import.meta.url),
);

function checkResults(results: unknown) {
  return spawnSync(process.execPath, [gate], {
    encoding: 'utf8',
    env: { ...process.env, CI_JOB_RESULTS: JSON.stringify(results) },
  });
}

describe('required CI gate', () => {
  it('accepts only a nonempty set of successful jobs', () => {
    const result = checkResults({
      checks: { result: 'success' },
      tests: { result: 'success' },
      build: { result: 'success' },
      coverage: { result: 'success' },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain('coverage: success');
  });

  it.each(['failure', 'cancelled', 'skipped', 'unknown'])(
    'rejects %s even when the other jobs succeeded',
    (status) => {
      const result = checkResults({
        checks: { result: 'success' },
        tests: { result: status },
      });
      expect(result.status).toBe(1);
      expect(result.stdout).toContain(`tests: ${status}`);
    },
  );

  it.each([null, [], {}, { checks: {} }, { tests: null }])(
    'rejects empty or missing job results: %j',
    (results) => {
      expect(checkResults(results).status).toBe(1);
    },
  );
});
