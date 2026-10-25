import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startDshHost, type DshHost } from './host.js';
import { readSessionLogs } from './session-log.js';
import type { LoggedSession } from './session-log.js';

/**
 * One isolated lifecycle case, with restart support.
 *
 * The deterministic model adapter is a fixture row on the real `llm` service,
 * so agent turns issue real `bash` calls through the host pipeline. Restart
 * keeps the same isolated home (profile, session logs, audit database) and
 * only swaps the process, which is what a cold restore actually is.
 */

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));

export interface CaseHost {
  readonly current: () => DshHost;
  /** Stop the process, keep the home, and start a new one on it. */
  readonly restart: () => Promise<DshHost>;
  /** Final teardown: stop the process and remove the isolated home. */
  readonly dispose: () => Promise<void>;
  readonly logs: () => Promise<readonly LoggedSession[]>;
}

const FIXTURE_ROW = {
  insert: [
    {
      id: 'arbiter-e2e-llm',
      name: 'file://' + join(repoRoot, 'tests/e2e/dsh/fixture-llm.ts'),
      config: { provider: 'arbiter-fixture' },
    },
    // The fixture owns the default model selection, so the host never asks for
    // a credential or reaches a real provider.
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: 'arbiter-fixture', model: 'arbiter-fixture' },
    },
  ],
};

export interface CaseOptions {
  /** The arbiter row's own configuration (rules, boundary, modes). */
  readonly arbiterRowConfig?: Record<string, unknown>;
}

export async function createCaseHost(
  artifacts: string,
  caseOptions: CaseOptions = {},
): Promise<CaseHost> {
  const options = {
    extraRows: [FIXTURE_ROW],
    ...(caseOptions.arbiterRowConfig === undefined
      ? {}
      : { arbiterRowConfig: caseOptions.arbiterRowConfig }),
  };
  let host = await startDshHost(repoRoot, artifacts, options);
  let home = host.home;
  let root = host.root;
  const dispose = async (): Promise<void> => {
    try {
      await host.stop();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  };
  return {
    current: () => host,
    logs: () => readSessionLogs(home),
    restart: async () => {
      // Keep the home on the first stop, then start a new process on it; the
      // case's final dispose removes the home.
      await host.stop({ keepHome: true });
      host = await startDshHost(repoRoot, join(artifacts, 'restart'), {
        ...options,
        restart: { root, home },
      });
      home = host.home;
      root = host.root;
      return host;
    },
    dispose,
  };
}
