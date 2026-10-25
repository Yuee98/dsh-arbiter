/**
 * Shared profile builder for this validation run.
 * One isolated DSH_HOME per case; bundles = base + web-app + the probe.
 */
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const RUN_ROOT = resolve(new URL('..', import.meta.url).pathname);
export const PROBE_DIR = join(RUN_ROOT, 'probes', 'pui-probe');
export const LLM_FIXTURE = join(RUN_ROOT, 'probes', 'llm-fixture.mjs');

export async function makeProfile({ home, profile, patchRows = [], llmScenario, workspace, extraBundles = [] }) {
  const dir = join(home, 'profiles', profile);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({
    name: `dsh-profile-${profile}`,
    private: true,
    dependencies: {},
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app', ...extraBundles] } },
  }, null, 2) + '\n');
  await writeFile(join(dir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(dir, 'cordis.yml'), '[]\n');
  const rows = [
    { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model', config: { provider: 'pui', model: 'fixture-1' } },
    { insert: [
      { id: 'pui-llm', name: 'file://' + LLM_FIXTURE, config: { provider: 'pui', scenarioPath: llmScenario } },
      { id: 'pui-probe', name: 'file://' + join(PROBE_DIR, 'index.js'), config: { logPath: join(home, 'pui', 'events.jsonl'), registerAuto: process.env.PUI_AUTO === '1' } },
    ] },
    ...patchRows,
  ];
  await writeFile(join(dir, 'cordis.patch.yml'), JSON.stringify(rows, null, 2) + '\n');
  return dir;
}

export async function writeJson(path, value) {
  await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

export function dshBin() { return '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness'; }
export function dshCli() { return '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js'; }
