#!/usr/bin/env node
/**
 * Summarize every case under cases/ into raw/case-index.json and a compact
 * console table. Reads only case artifacts the driver already wrote: it never
 * re-runs anything, so the index is a view of the recorded evidence.
 */
import { existsSync } from "node:fs";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const runRoot = resolve(here, "..");
const casesRoot = join(runRoot, "cases");
const SESSION_DECODER = join(here, "inspect-session.mjs");

import { execFileSync } from "node:child_process";

function decodeSession(file) {
  try {
    const stdout = execFileSync(
      process.execPath,
      [SESSION_DECODER, file, "tool/", "approval/", "subagent/", "sandbox/", "permission/", "session"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    );
    return stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

const ids = (await readdir(casesRoot)).sort();
const index = [];
for (const id of ids) {
  const dir = join(casesRoot, id);
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) continue;
  const result = JSON.parse(await readFile(resultPath, "utf8"));
  const probe = existsSync(join(dir, "probe.jsonl"))
    ? (await readFile(join(dir, "probe.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const decisions = probe.filter((event) => event.event === "probe/decision" || event.event === "probe/guard");
  const toolCalls = probe.filter((event) => event.event === "probe/pre-execute");
  const executed = probe.filter((event) => event.event === "probe/execute");
  const results = probe.filter((event) => event.event === "probe/result");
  const order = probe.filter((event) => event.event === "probe/order-snapshot" && Array.isArray(event.order) && event.order.length > 0).at(-1);
  const durable = [];
  for (const file of result.sessionLogs ?? []) {
    for (const event of decodeSession(file)) {
      if (!String(event.type).startsWith("tool/") && !String(event.type).startsWith("approval/") && !String(event.type).startsWith("subagent/")) continue;
      durable.push({ file: file.slice(file.lastIndexOf("/") + 1), type: event.type, data: event.data });
    }
  }
  index.push({
    caseId: id,
    group: result.group,
    title: result.title,
    exitCode: result.exitCode,
    toolsMode: result.toolsMode,
    sandboxMode: result.sandboxMode,
    approvalPolicy: result.approvalPolicy,
    probePrepend: result.probePrepend,
    approvalSim: result.approvalSim,
    preExecute: toolCalls.map((event) => ({
      name: event.name,
      callId: event.callId,
      rootCallId: event.rootCallId,
      parentToken: event.parentToken,
      agentSessionId: event.agentSessionId,
      sessionParent: event.sessionParent,
      sessionOrigin: event.sessionOrigin,
      ruleId: event.ruleId,
      action: event.action
    })),
    decisions: decisions.map((event) => ({ kind: event.event, ruleId: event.ruleId, name: event.name, action: event.action ?? event.decision })),
    executed: executed.map((event) => ({ name: event.name, callId: event.callId })),
    resultErrors: results.map((event) => ({ name: event.name, isError: event.isError, errorMessage: event.errorMessage })),
    listeners: order?.order ?? null,
    markers: Object.fromEntries(Object.entries(result.markers ?? {}).map(([key, value]) => [key, value.exists])),
    markerContents: Object.fromEntries(Object.entries(result.markers ?? {}).map(([key, value]) => [key, value.content ?? null])),
    mcpInbound: (result.mcpReceipt ?? []).filter((entry) => entry.direction === "in").map((entry) => entry.payload?.method ?? "?"),
    mcpToolCalls: (result.mcpReceipt ?? []).filter((entry) => entry.direction === "in" && entry.payload?.method === "tools/call").map((entry) => entry.payload.params),
    mcpResourceReads: (result.mcpReceipt ?? []).filter((entry) => entry.direction === "in" && entry.payload?.method === "resources/read").map((entry) => entry.payload.params),
    network: (result.networkReceipt ?? []).length,
    approvalSim: (result.approvalSimLog ?? []).filter((entry) => entry.event === "approval-sim/answer"),
    durable: durable.map((event) => ({
      file: event.file,
      type: event.type,
      callId: event.data?.callId ?? event.data?.subCallId ?? null,
      parentCallId: event.data?.parentCallId ?? null,
      rootCallId: event.data?.rootCallId ?? null,
      name: event.data?.name ?? event.data?.toolName ?? null,
      outcome: event.data?.outcome ?? null,
      policy: event.data?.policy ?? null,
      mode: event.data?.mode ?? null,
      label: event.data?.label ?? null,
      provider: event.data?.provider ?? null
    }))
  });
}

await writeFile(join(runRoot, "raw", "case-index.json"), JSON.stringify(index, null, 2));
for (const entry of index) {
  process.stdout.write(
    entry.caseId +
      " | exit " + entry.exitCode +
      " | pre " + entry.preExecute.map((call) => call.name + (call.action === "pass" ? "" : ":" + call.action)).join(",") +
      " | markers " + JSON.stringify(entry.markers) +
      " | mcp " + JSON.stringify(entry.mcpToolCalls.map((call) => call?.name)) +
      "\n"
  );
}
