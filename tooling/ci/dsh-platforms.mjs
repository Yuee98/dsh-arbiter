import { execFileSync, spawnSync } from 'node:child_process';
import console from 'node:console';
import { appendFileSync } from 'node:fs';
import process from 'node:process';

const all = ['ubuntu-24.04', 'macos-15', 'windows-2025'];
const event = process.env['DSH_E2E_EVENT'];
if (!event) throw new Error('DSH_E2E_EVENT is required.');
const requested = process.env['DSH_E2E_PLATFORMS'] || 'ubuntu-24.04';
const output = process.env['GITHUB_OUTPUT'];
if (!output) throw new Error('GITHUB_OUTPUT is required.');

let platforms = ['ubuntu-24.04'];
let reason;
switch (event) {
  case 'pull_request': {
    const base = process.env['DSH_E2E_BASE_SHA'];
    if (!base || !/^[a-f0-9]{40}$/.test(base)) {
      throw new Error('A full pull request base SHA is required.');
    }
    const available = spawnSync('git', ['cat-file', '-e', `${base}^{commit}`]);
    if (available.error) throw available.error;
    if (available.status !== 0) {
      execFileSync('git', ['fetch', '--no-tags', '--depth=1', 'origin', base]);
    }
    // Compare the base with checkout's PR merge tree. Include deleted and
    // renamed paths, and never interpret file names as shell arguments.
    const files = execFileSync(
      'git',
      ['diff', '--no-renames', '--name-only', '-z', base, 'HEAD'],
      { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
    ).split('\0');
    const runtimeChanged = files.some((file) =>
      file.startsWith('tests/e2e/runtime/'),
    );
    platforms = runtimeChanged ? all : platforms;
    reason = runtimeChanged ? 'runtime-change' : 'related-pr';
    break;
  }
  case 'push':
    reason = 'main-push';
    break;
  case 'workflow_dispatch':
    if (requested !== 'all' && !all.includes(requested)) {
      throw new Error(`Unsupported platform: ${requested}`);
    }
    platforms = requested === 'all' ? all : [requested];
    reason = 'manual';
    break;
  default:
    throw new Error(`Unsupported event: ${event}`);
}

appendFileSync(
  output,
  `platforms=${JSON.stringify(platforms)}\nreason=${reason}\n`,
);
console.log(`DSH platform selection: ${reason}: ${platforms.join(', ')}`);
