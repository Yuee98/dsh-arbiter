#!/usr/bin/env node
/**
 * Fixed-decision expectations for the validation run.
 *
 * The probe returns FIXED verdicts (never a model judgement), so the expected
 * outcome of every case is a constant. This script re-reads the recorded
 * artifacts and asserts those constants — it never re-runs DSH and never
 * consults a model. A mismatch means the recorded evidence no longer supports
 * the report.
 *
 * usage: node scripts/check.mjs
 */
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, "..");
const indexPath = join(runRoot, "raw", "case-index.json");

if (!existsSync(indexPath)) {
  console.error("missing raw/case-index.json — run scripts/summarize.mjs first");
  process.exit(2);
}
const index = JSON.parse(await readFile(indexPath, "utf8"));
const byId = new Map(index.map((entry) => [entry.caseId, entry]));

const failures = [];
let passed = 0;
function check(label, actual, expected) {
  if (actual === expected) {
    passed += 1;
    return;
  }
  failures.push(label + ": expected " + JSON.stringify(expected) + ", got " + JSON.stringify(actual));
}

// Every side-effect marker: did the body actually run?
const markers = [
  ["g1-a-bash-allow", "marker", true],
  ["g1-b-bash-deny", "marker", false],
  ["g1-c-bash-pass", "marker", true],
  ["g1-e-guard-vs-probe-allow", "marker", false],
  ["g1-f-guard-pass-control", "marker", true],
  ["g1-g-prepend-order", "marker", true],
  ["g1-h-with-auto-review-bundle", "marker", true],
  ["g2-a-outer-allow", "program", true],
  ["g2-a-outer-allow", "inner", true],
  ["g2-b-outer-deny", "program", false],
  ["g2-b-outer-deny", "inner", false],
  ["g2-c-inner-deny-catch", "program", true],
  ["g2-c-inner-deny-catch", "denied", false],
  ["g2-c-inner-deny-catch", "allowed", true],
  ["g2-d-concurrent-inner", "program", true],
  ["g3-a-full-access", "inside", true],
  ["g3-a-full-access", "outsideRel", true],
  ["g3-b-workspace-write", "inside", true],
  ["g3-b-workspace-write", "outsideRel", false],
  ["g3-c-bash-workspace-write", "inside", true],
  ["g3-c-bash-workspace-write", "outsideRel", false],
  ["g3-d-workspace-write-acl-outside", "outside", false],
  ["g3-e-full-access-acl-outside", "outside", true],
  ["g3-f-workspace-write-acl-inside", "inside", true],
  ["g3-g-workspace-write-tmp", "tmp", true],
  ["g5-a-spawn-child-allow", "childMarker", true],
  ["g5-b-spawn-child-deny", "childMarker", false],
  ["g5-c-fork-child-deny", "forkMarker", false],
  ["g5-e-fork-child-allow", "forkMarker", true],
  ["g5-d-child-ask-never", "askMarker", false],
  ["g6-a-workflow-tool-deny", "inner", false],
  ["g6-b-workflow-tool-allow-inner-deny", "inner", false],
  ["g6-c-workflow-tool-allow-inner-allow", "inner", true],
  ["g6-d-workflow-vs-direct-delegation", "direct", true],
  ["g6-d-workflow-vs-direct-delegation", "workflow", true],
  ["g7-a-bash-escalate-tool-allow", "outside", false],
  ["g7-b-run-code-escalate-tool-allow", "outside", false],
  ["g7-c-bash-escalate-no-tool-rule", "outside", false],
  ["g7-d-bash-escalate-sim-allowed", "outside", true],
  ["g7-e-run-code-escalate-sim-allowed", "outside", true],
  ["g7-f-bash-escalate-sim-rejected", "outside", false]
];
for (const [id, key, want] of markers) {
  const entry = byId.get(id);
  if (entry === undefined) {
    failures.push(id + ": case missing from index");
    continue;
  }
  check(id + " / " + key, entry.markers[key], want);
}

// MCP: the server receipt proves whether the RPC left the host.
check("g4-a sends exactly one tools/call", byId.get("g4-a-mcp-direct-allow").mcpToolCalls.length, 1);
check("g4-b sends no tools/call", byId.get("g4-b-mcp-direct-deny").mcpToolCalls.length, 0);
check("g4-c sends one of two inner calls", byId.get("g4-c-mcp-inside-run-code").mcpToolCalls.length, 1);
check("g4-d reads one resource", byId.get("g4-d-mcp-resources-allow").mcpResourceReads.length, 1);
check("g4-e sends no resources/read", byId.get("g4-e-mcp-resources-deny").mcpResourceReads.length, 0);

// The MCP server must have completed its handshake even when the call was denied,
// otherwise "no receipt" could just mean "the server never started".
for (const id of ["g4-b-mcp-direct-deny", "g4-e-mcp-resources-deny"]) {
  const entry = byId.get(id);
  check(id + " completed initialize", entry.mcpInbound.includes("initialize"), true);
  check(id + " listed tools", entry.mcpInbound.includes("tools/list"), true);
}

// Network: the local receiver only sees traffic that really left the program.
for (const id of ["g3-a-full-access", "g3-b-workspace-write"]) {
  check(id + " reached the local receiver", byId.get(id).network > 0, true);
}

// run_code correlation: inner callIds extend the outer one and share rootCallId.
for (const id of ["g2-a-outer-allow", "g2-c-inner-deny-catch", "g2-d-concurrent-inner"]) {
  const entry = byId.get(id);
  const outer = entry.preExecute.find((call) => call.name === "run_code");
  const inner = entry.preExecute.filter((call) => call.parentToken !== null);
  check(id + " has inner dispatches", inner.length > 0, true);
  for (const call of inner) {
    check(id + " inner callId prefix", call.callId.startsWith(outer.callId + ":ptc:"), true);
    check(id + " inner rootCallId", call.rootCallId, outer.rootCallId);
  }
}

// Subagent identity: the child's session header names the parent session.
for (const id of ["g5-a-spawn-child-allow", "g5-b-spawn-child-deny", "g5-c-fork-child-deny", "g5-d-child-ask-never"]) {
  const entry = byId.get(id);
  const child = entry.preExecute.find((call) => call.sessionParent !== null && call.sessionParent !== undefined);
  check(id + " has a child session", child !== undefined, true);
  if (child !== undefined) check(id + " child origin", child.sessionOrigin, "subagent");
}

// Listener order: the probe never precedes an existing prepend listener.
const order = byId.get("g1-a-bash-allow").listeners ?? [];
const probeIndex = order.findIndex((hook) => hook.label === "decide");
const earlierPrepend = order.slice(0, probeIndex).filter((hook) => hook.prepend === true);
check("probe is after a host prepend listener", earlierPrepend.length >= 1, true);

for (const failure of failures) console.error("FAIL " + failure);
console.log(passed + " passed, " + failures.length + " failed");
process.exit(failures.length === 0 ? 0 : 1);
