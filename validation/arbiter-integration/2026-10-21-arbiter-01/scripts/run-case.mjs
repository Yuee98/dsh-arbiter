#!/usr/bin/env node
/**
 * dsh-arbiter integration runner.
 *
 * One case = one isolated DSH_HOME, one self-built profile, the real shipped
 * `dsh` CLI in headless mode, and a deterministic LLM fixture. The fixture
 * replays the agent's tool call and answers reviewer requests from the case
 * script. This runner records facts; assertions live in `check.mjs`.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { cp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { statSync } from 'node:fs';

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, '..');
const repoRoot = resolve(runRoot, '../../..');
const fixtures = join(runRoot, 'fixtures');
const casesRoot = join(runRoot, 'cases');

const DSH_BIN = '/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness';
const DSH_CLI =
  '/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js';

function profileManifest() {
  return (
    JSON.stringify(
      {
        name: 'dsh-profile-arbiter-it',
        private: true,
        dependencies: { 'dsh-arbiter': `link:${repoRoot}` },
        dsh: {
          profile: {
            bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-headless'],
          },
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function patchFor(spec, paths) {
  const rows = [
    {
      id: 'permission',
      name: '@deepseek-ai/dsh-permission-presets',
      config: {
        presets: {
          'arbiter-trusted': { sandbox: spec.sandbox ?? 'danger-full-access', approval: spec.approvalPolicy ?? 'ask' },
        },
        defaultPreset: 'arbiter-trusted',
      },
    },
    {
      id: 'agent-default-model',
      name: '@deepseek-ai/dsh-agent-default-model',
      config: { provider: 'arbiterfs', model: 'fixture-1' },
    },
    { id: 'tools', name: '@deepseek-ai/dsh-tools', config: { mode: spec.toolsMode ?? 'native' } },
    {
      id: 'sandbox-policy',
      name: '@deepseek-ai/dsh-sandbox-policy',
      config: { mode: spec.sandbox ?? 'danger-full-access', workspaceRoot: paths.workspace },
    },
    { id: 'approval', name: '@deepseek-ai/dsh-user-approval', config: { policy: spec.approvalPolicy ?? 'ask' } },
  ];
  rows.push({
    insert: [
      {
        id: 'arbiter-llm',
        name: `file://${join(fixtures, 'arbiter-llm.mjs')}`,
        config: { provider: 'arbiterfs', scenarioPath: paths.scenario },
      },
      ...(spec.approvalSim === undefined
        ? []
        : [
            {
              id: 'arbiter-approval-sim',
              name: `file://${join(fixtures, 'approval-sim.mjs')}`,
              config: { logPath: paths.approvalLog, outcome: spec.approvalSim },
            },
          ]),
      {
        id: 'arbiter',
        name: 'dsh-arbiter',
        config: {
          enabled: true,
          modes: { main: spec.mode ?? 'normal', subagent: spec.subagentMode ?? 'strict' },
          rules: spec.rules ?? [],
          reviewer: {
            type: 'chat',
            chat: { provider: 'session', model: '', temperature: 0, maxTokens: 400, timeoutMs: 8000, maxRepairRetries: spec.maxRepairRetries ?? 1 },
          },
          ...(spec.breaker === undefined ? {} : { breaker: spec.breaker }),
          ...(spec.audit === undefined ? {} : { audit: spec.audit }),
          ...(spec.policy === undefined ? {} : { policy: spec.policy }),
        },
      },
    ],
  });
  return JSON.stringify(rows, null, 2).split('{{WORKSPACE}}').join(paths.workspace);
}

async function filesUnder(dir, prefix = '', out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await filesUnder(full, rel, out);
    else {
      const info = await stat(full);
      out.push({ path: rel, bytes: info.size });
    }
  }
  return out;
}

function readJsonl(path) {
  if (!existsSync(path)) return [];
  return readFile(path, 'utf8').then((text) =>
    text
      .split('\n')
      .filter((line) => line.trim().length > 0)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return { unparsable: line };
        }
      }),
  );
}

function readCalls(home) {
  const path = join(home, 'arbiter', 'arbiter.db');
  if (!existsSync(path)) return { exists: false, calls: [], modelCalls: [], candidates: [] };
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const calls = db
      .prepare('SELECT call_id, session_kind, result, reason, trace, execution_status, approval_mode, signals FROM calls ORDER BY ts')
      .all()
      .map((row) => ({
        ...row,
        trace: JSON.parse(row.trace ?? '[]'),
        signals: row.signals === null ? null : JSON.parse(row.signals),
      }));
    const modelCalls = db
      .prepare('SELECT call_id, attempt, backend, error, response_text, parsed FROM model_calls ORDER BY started_at')
      .all();
    const candidates = db.prepare('SELECT candidate_id, status, rule, stats FROM candidates').all();
    return { exists: true, bytes: statSyncSize(path), calls, modelCalls, candidates };
  } finally {
    db.close();
  }
}

function statSyncSize(path) {
  try {
    return statSync(path).size;
  } catch {
    return 0;
  }
}

async function runCase(spec) {
  const caseDir = join(casesRoot, spec.id);
  const home = join(caseDir, 'home');
  const profileDir = join(home, 'profiles', 'arbiter-it');
  const workspace = join(caseDir, 'ws');
  await rm(caseDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(join(profileDir, 'node_modules'), { recursive: true });
  await symlink(repoRoot, join(profileDir, 'node_modules', 'dsh-arbiter'), 'dir');

  if (spec.auditUnavailable === true) {
    // A file where the audit directory must be makes SQLite open fail.
    await writeFile(join(home, 'arbiter'), 'not a directory', 'utf8');
  }

  const paths = {
    caseDir,
    scenario: join(caseDir, 'scenario.json'),
    workspace,
    approvalLog: join(caseDir, 'approval-sim.jsonl'),
  };
  const scenario = spec.scenario ?? {
    default: [
      {
        type: 'calls',
        text: 'run it',
        calls: [
          {
            name: 'bash',
            arguments: {
              command: spec.command ?? 'echo ARBITER_MARKER > marker.txt',
              description: 'write the integration marker',
            },
          },
        ],
      },
      { type: 'text', text: 'done' },
    ],
    reviewer: spec.reviewer ?? [],
  };
  if (spec.reviewer !== undefined && spec.scenario !== undefined) scenario.reviewer = spec.reviewer;
  await writeFile(paths.scenario, JSON.stringify(scenario, null, 2));
  await writeFile(join(profileDir, 'package.json'), profileManifest());
  await writeFile(join(profileDir, 'pnpm-workspace.yaml'), 'packages: []\n');
  await writeFile(join(profileDir, 'cordis.yml'), '[]\n');
  await writeFile(join(profileDir, 'cordis.patch.yml'), patchFor(spec, paths));

  const started = Date.now();
  const child = spawn(
    DSH_BIN,
    ['--expose-internals', DSH_CLI, '--profile', 'arbiter-it', spec.task ?? 'write the integration marker'],
    {
      cwd: workspace,
      env: {
        ...process.env,
        DSH_HOME: home,
        DSH_TELEMETRY_DISABLED: '1',
        ELECTRON_RUN_AS_NODE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => (stdout += chunk));
  child.stderr.on('data', (chunk) => (stderr += chunk));
  const timer = setTimeout(() => child.kill('SIGKILL'), spec.timeoutMs ?? 120000);
  const exitCode = await new Promise((resolveExit) => {
    child.on('exit', (code, signal) => resolveExit(code === null ? `signal:${signal}` : code));
    child.on('error', (error) => {
      stderr += `\n[driver] spawn error: ${String(error)}\n`;
      resolveExit('spawn-error');
    });
  });
  clearTimeout(timer);

  const markerPath = join(workspace, spec.marker ?? 'marker.txt');
  const marker = existsSync(markerPath)
    ? { exists: true, content: (await readFile(markerPath, 'utf8')).slice(0, 500) }
    : { exists: false };

  const audit = readCalls(home);
  const reviewerRequests = await readJsonl(join(caseDir, 'reviewer-requests.jsonl'));
  const agentRequests = await readJsonl(join(caseDir, 'agent-requests.jsonl'));
  const approvalSim = await readJsonl(join(caseDir, 'approval-sim.jsonl'));

  const sessionLogs = [];
  try {
    for (const workspaceKey of await readdir(join(home, 'sessions'))) {
      for (const sessionId of await readdir(join(home, 'sessions', workspaceKey))) {
        const sessionDir = join(home, 'sessions', workspaceKey, sessionId);
        for (const file of await readdir(sessionDir)) {
          if (!file.startsWith('session.') || !file.includes('jsonl')) continue;
          const to = join(caseDir, 'sessions', `${sessionId}__${file}`);
          await mkdir(join(caseDir, 'sessions'), { recursive: true });
          await cp(join(sessionDir, file), to);
          sessionLogs.push(to);
        }
      }
    }
  } catch {
    // No session was created.
  }

  const result = {
    caseId: spec.id,
    title: spec.title,
    task: spec.task ?? 'write the integration marker',
    startedAt: new Date().toISOString(),
    elapsedMs: Date.now() - started,
    exitCode,
    stdout,
    stderrTail: stderr.slice(-8000),
    marker,
    audit,
    reviewerRequests,
    agentRequests,
    approvalSim,
    sessionLogs,
    profile: {
      mode: spec.mode ?? 'normal',
      subagentMode: spec.subagentMode ?? 'strict',
      approvalPolicy: spec.approvalPolicy ?? 'ask',
      sandbox: spec.sandbox ?? 'danger-full-access',
      toolsMode: spec.toolsMode ?? 'native',
      rules: spec.rules ?? [],
      reviewerScript: spec.reviewer ?? [],
    },
    files: await filesUnder(caseDir),
  };
  await writeFile(join(caseDir, 'stdout.txt'), stdout);
  await writeFile(join(caseDir, 'stderr.txt'), stderr);
  await writeFile(join(caseDir, 'result.json'), JSON.stringify(result, null, 2));
  return result;
}

const scenariosPath = join(runRoot, 'scenarios', 'cases.json');
const specs = JSON.parse(await readFile(scenariosPath, 'utf8'));
const results = [];
for (const spec of specs) {
  process.stderr.write(`[run] ${spec.id}\n`);
  results.push(await runCase(spec));
}
await writeFile(join(runRoot, 'raw', 'results.json'), JSON.stringify(results, null, 2));
console.log(
  JSON.stringify(
    results.map((result) => ({
      caseId: result.caseId,
      exitCode: result.exitCode,
      marker: result.marker.exists,
      calls: result.audit.calls.map((call) => ({
        result: call.result,
        execution: call.execution_status,
        trace: call.trace.map((stage) => stage.result),
      })),
      modelCalls: result.audit.modelCalls.length,
      reviewerRequests: result.reviewerRequests.length,
      auditExists: result.audit.exists,
    })),
    null,
    2,
  ),
);
