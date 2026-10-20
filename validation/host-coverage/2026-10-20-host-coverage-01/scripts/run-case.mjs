#!/usr/bin/env node
/**
 * Host-coverage validation driver.
 *
 * One case = one isolated DSH_HOME + one profile composed from the shipped
 * dsh-base/dsh-headless bundles + the fixtures' patch overlay, run through the
 * real `dsh` CLI in headless mode with a deterministic LLM fixture.
 *
 * Everything a case observes lands in <run>/cases/<caseId>/:
 *   home/profiles/hostcov/  the generated profile (package.json + cordis.patch.yml)
 *   scenario.json           the LLM fixture script
 *   probe.jsonl             the probe plugin's own JSONL log
 *   stdout.txt / stderr.txt the CLI's streams
 *   result.json             exit code + case metadata + side-effect marker probes
 *
 * The driver never decides pass/fail. It records facts; the report is written
 * by hand from those facts.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { cp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, "..");
const fixtures = join(runRoot, "fixtures");
const casesRoot = join(runRoot, "cases");

const DSH_BIN = "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness";
const DSH_CLI =
  "/Applications/DeepSeek Harness.app/Contents/Resources/app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js";

function profileManifest(extraBundles = []) {
  return (
    JSON.stringify(
      {
        name: "dsh-profile-hostcov",
        private: true,
        dependencies: {},
        dsh: {
          profile: {
            bundles: ["@deepseek-ai/dsh-base", "@deepseek-ai/dsh-headless", ...extraBundles]
          }
        }
      },
      null,
      2
    ) + "\n"
  );
}

/** Build the patch layer for one case. */
function buildPatch(caseSpec, paths) {
  const rows = [];

  // Deterministic model route. The fixture adapter registers "hostcov".
  rows.push({
    id: "agent-default-model",
    name: "@deepseek-ai/dsh-agent-default-model",
    config: { provider: "hostcov", model: "fixture-1" }
  });

  if (caseSpec.toolsMode !== undefined) {
    rows.push({ id: "tools", name: "@deepseek-ai/dsh-tools", config: { mode: caseSpec.toolsMode } });
  }

  if (caseSpec.sandboxMode !== undefined) {
    rows.push({
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      config: { mode: caseSpec.sandboxMode, workspaceRoot: caseSpec.workspaceRoot ?? paths.workspace }
    });
  }

  if (caseSpec.approvalPolicy !== undefined) {
    rows.push({ id: "approval", name: "@deepseek-ai/dsh-user-approval", config: { policy: caseSpec.approvalPolicy } });
  }

  if (caseSpec.baseRows !== undefined) rows.push(...caseSpec.baseRows);

  const inserted = [];

  inserted.push({
    id: "hostcov-llm",
    name: "file://" + join(fixtures, "llm-fixture.mjs"),
    config: { provider: "hostcov", scenarioPath: paths.scenario }
  });

  inserted.push({
    id: "hostcov-probe",
    name: "file://" + join(fixtures, "probe.mjs"),
    config: {
      logPath: paths.probeLog,
      prepend: caseSpec.probePrepend === true,
      snapshotDelayMs: 2500,
      rules: caseSpec.rules ?? [],
      guardRules: caseSpec.guardRules ?? []
    }
  });

  if (caseSpec.approvalSim !== undefined) {
    inserted.push({
      id: "hostcov-approval-sim",
      name: "file://" + join(fixtures, "approval-sim.mjs"),
      config: { logPath: join(paths.caseDir, "approval-sim.jsonl"), outcome: caseSpec.approvalSim }
    });
  }

  if (caseSpec.mcpServerName !== undefined) {
    inserted.push({
      id: "hostcov-mcp",
      name: "@deepseek-ai/dsh-mcp-client",
      config: {
        transport: "stdio",
        serverName: caseSpec.mcpServerName,
        command: process.execPath,
        args: [join(fixtures, "mcp-test-server.mjs"), paths.mcpReceipt],
        env: { HOSTCOV_CASE: caseSpec.id },
        failOnStartupError: true,
        reconnect: { enabled: false }
      }
    });
  }

  if (caseSpec.extraInserts !== undefined) inserted.push(...caseSpec.extraInserts);

  const patch = [...rows];
  if (inserted.length > 0) patch.push({ insert: inserted });
  return patch;
}

function toYaml(value) {
  // JSON is valid YAML; the loader parses the patch list with a YAML parser,
  // so emitting JSON keeps quoting/indentation unambiguous.
  return JSON.stringify(value, null, 2);
}

async function listFiles(dir, prefix = "", out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const rel = prefix === "" ? entry.name : prefix + "/" + entry.name;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await listFiles(full, rel, out);
    else {
      const info = await stat(full);
      out.push({ path: rel, bytes: info.size });
    }
  }
  return out;
}

/** Side-effect probes: marker files and their post-run contents. */
async function collectMarkers(markerFiles) {
  const out = {};
  for (const [label, file] of Object.entries(markerFiles)) {
    try {
      out[label] = { exists: true, path: file, content: (await readFile(file, "utf8")).slice(0, 500) };
    } catch {
      out[label] = { exists: false, path: file };
    }
  }
  return out;
}

async function runCase(caseSpec) {
  const caseDir = join(casesRoot, caseSpec.id);
  const home = join(caseDir, "home");
  const profileDir = join(home, "profiles", "hostcov");
  const workspace = join(caseDir, "ws");
  const outside = join(caseDir, "outside");
  const work = workspace;

  await rm(caseDir, { recursive: true, force: true });
  await mkdir(profileDir, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });

  const paths = {
    caseDir,
    scenario: join(caseDir, "scenario.json"),
    probeLog: join(caseDir, "probe.jsonl"),
    mcpReceipt: join(caseDir, "mcp-receipt.jsonl"),
    workspace,
    markerFiles: {}
  };

  for (const file of caseSpec.fixtureFiles ?? []) {
    const target = join(caseDir, file.target);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, file.content, "utf8");
  }
  for (const [rel, content] of Object.entries(caseSpec.seedFiles ?? {})) {
    const target = join(workspace, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content, "utf8");
  }

  let receiver = null;
  let receiverPort = "";
  if (caseSpec.needsPort === true) {
    const receipt = join(caseDir, "network-receipt.jsonl");
    const portFile = join(caseDir, "network-port.txt");
    receiver = spawn(process.execPath, [join(fixtures, "tcp-receiver.mjs"), receipt, portFile], {
      stdio: ["ignore", "pipe", "pipe"]
    });
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(portFile)) {
        const raw = (await readFile(portFile, "utf8")).trim();
        if (raw.length > 0) {
          receiverPort = raw;
          break;
        }
      }
      await new Promise((wait) => setTimeout(wait, 50));
    }
  }

  const substitute = (text) =>
    text
      .split("{{WS}}").join(workspace)
      .split("{{OUTSIDE}}").join(outside)
      .split("{{CASE}}").join(caseDir)
      .split("{{PORT}}").join(receiverPort);
  await writeFile(paths.scenario, substitute(JSON.stringify(caseSpec.scenario, null, 2)));
  await writeFile(join(profileDir, "package.json"), profileManifest(caseSpec.extraBundles ?? []));
  await writeFile(join(profileDir, "pnpm-workspace.yaml"), "packages: []\n");
  await writeFile(join(profileDir, "cordis.yml"), "[]\n");
  const patch = buildPatch(caseSpec, paths);
  await writeFile(
    join(profileDir, "cordis.patch.yml"),
    "# generated by run-case.mjs for " + caseSpec.id + "\n" + toYaml(patch) + "\n"
  );

  const args = [
    "--expose-internals",
    DSH_CLI,
    "--profile",
    "hostcov",
    ...(caseSpec.cliArgs ?? []),
    caseSpec.task
  ];

  const started = Date.now();
  const child = spawn(DSH_BIN, args, {
    cwd: work,
    env: {
      ...process.env,
      DSH_HOME: home,
      DSH_TELEMETRY_DISABLED: "1",
      ELECTRON_RUN_AS_NODE: "1",
      HOSTCOV_PORT: receiverPort
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));

  const timeoutMs = caseSpec.timeoutMs ?? 120000;
  const timer = setTimeout(() => {
    stderr += "\n[driver] case timeout: killing child\n";
    child.kill("SIGKILL");
  }, timeoutMs);

  const exitCode = await new Promise((resolveExit) => {
    child.on("exit", (code, signal) => resolveExit(code === null ? "signal:" + signal : code));
    child.on("error", (error) => {
      stderr += "\n[driver] spawn error: " + String(error) + "\n";
      resolveExit("spawn-error");
    });
  });
  clearTimeout(timer);
  if (receiver !== null) {
    receiver.kill("SIGTERM");
    await new Promise((wait) => setTimeout(wait, 200));
    try {
      receiver.kill("SIGKILL");
    } catch {}
  }

  const markerFiles = {};
  for (const [label, rel] of Object.entries(caseSpec.markers ?? {})) {
    if (rel === "WS") markerFiles[label] = workspace;
    else if (rel === "OUTSIDE") markerFiles[label] = outside;
    else if (rel.startsWith("{{OUTSIDE}}")) markerFiles[label] = join(outside, rel.slice("{{OUTSIDE}}/".length));
    else markerFiles[label] = rel.startsWith("/") ? rel : join(workspace, rel);
  }

  await writeFile(join(caseDir, "stdout.txt"), stdout);
  await writeFile(join(caseDir, "stderr.txt"), stderr);

  // Persisted session logs: the host's own durable record. Copied next to the
  // probe log so the evidence bundle is self-contained.
  const sessionLogs = [];
  try {
    // home/sessions/<workspace-key>/<session-id>/session.v4.jsonl.zstd
    for (const workspaceKey of await readdir(join(home, "sessions"))) {
      for (const sessionId of await readdir(join(home, "sessions", workspaceKey))) {
        const sessionDir = join(home, "sessions", workspaceKey, sessionId);
        let entries;
        try {
          entries = await readdir(sessionDir);
        } catch {
          continue;
        }
        for (const file of entries) {
          if (!file.startsWith("session.") || !file.includes("jsonl")) continue;
          const to = join(caseDir, "sessions", sessionId + "__" + file);
          await mkdir(join(caseDir, "sessions"), { recursive: true });
          await cp(join(sessionDir, file), to);
          sessionLogs.push(to);
        }
      }
    }
  } catch {
    // no sessions directory: a case that failed before creating an agent
  }

  const probeEvents = [];
  if (existsSync(paths.probeLog)) {
    for (const line of (await readFile(paths.probeLog, "utf8")).split("\n")) {
      if (line.trim().length === 0) continue;
      try {
        probeEvents.push(JSON.parse(line));
      } catch {
        probeEvents.push({ event: "probe/unparsable", line });
      }
    }
  }

  const result = {
    caseId: caseSpec.id,
    group: caseSpec.group,
    title: caseSpec.title,
    task: caseSpec.task,
    cliArgs: caseSpec.cliArgs ?? [],
    toolsMode: caseSpec.toolsMode ?? null,
    sandboxMode: caseSpec.sandboxMode ?? null,
    approvalPolicy: caseSpec.approvalPolicy ?? null,
    approvalSim: caseSpec.approvalSim ?? null,
    probePrepend: caseSpec.probePrepend === true,
    env: {
      dshHome: home,
      workspace,
      outside,
      cwd: work,
      platform: process.platform,
      node: process.version
    },
    elapsedMs: Date.now() - started,
    exitCode,
    stdout,
    stderrTail: stderr.slice(-8000),
    probeEventCount: probeEvents.length,
    markers: await collectMarkers(markerFiles),
    approvalSimLog: existsSync(join(caseDir, "approval-sim.jsonl"))
      ? (await readFile(join(caseDir, "approval-sim.jsonl"), "utf8"))
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [],
    mcpReceipt: existsSync(paths.mcpReceipt)
      ? (await readFile(paths.mcpReceipt, "utf8"))
          .split("\n")
          .filter((line) => line.trim().length > 0)
          .map((line) => JSON.parse(line))
      : [],
    networkReceipt: existsSync(join(caseDir, "network-receipt.jsonl"))
      ? (await readFile(join(caseDir, "network-receipt.jsonl"), "utf8")).split("\n").filter((line) => line.trim().length > 0)
      : [],
    receiverPort,
    sessionLogs,
    files: await listFiles(caseDir),
    notes: caseSpec.notes ?? ""
  };
  await writeFile(join(caseDir, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

const specPath = process.argv[2];
if (specPath === undefined) {
  console.error("usage: run-case.mjs <case-spec.json>");
  process.exit(2);
}
const spec = JSON.parse(await readFile(specPath, "utf8"));
const cases = Array.isArray(spec) ? spec : [spec];
const results = [];
for (const caseSpec of cases) {
  process.stderr.write("[driver] case " + caseSpec.id + "\n");
  results.push(await runCase(caseSpec));
}
process.stdout.write(JSON.stringify(results, null, 2) + "\n");
