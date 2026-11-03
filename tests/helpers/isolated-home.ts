/** Every test file owns its fallback home before any test module is imported. */
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll } from 'vitest';

const inheritedHome = process.env['DSH_HOME'];
const home = realpathSync(mkdtempSync(join(tmpdir(), 'arbiter-test-home-')));
process.env['DSH_HOME'] = home;

// Vitest's stack order runs this first-registered afterAll after file teardown.
afterAll(() => {
  try {
    rmSync(home, { recursive: true, force: true });
  } finally {
    if (inheritedHome === undefined) delete process.env['DSH_HOME'];
    else process.env['DSH_HOME'] = inheritedHome;
  }
});
