#!/usr/bin/env node
/**
 * Local MCP test server (JSON-RPC over stdio, newline-delimited).
 *
 * Deliberately hand-rolled rather than using the SDK's server half: the point
 * of this fixture is to log EVERY inbound JSON-RPC frame to a receipt file
 * before answering, so a denied tool call can be proved never to have reached
 * the server. It answers the legacy (2025-11-25) handshake; the era probe
 * (server/discover) is answered with method-not-found, which the client
 * classifies as "legacy".
 *
 * Usage: node mcp-test-server.mjs <receipt-log-path>
 */
import { appendFileSync } from "node:fs";

const receiptPath = process.argv[2];
if (!receiptPath) {
  process.stderr.write("mcp-test-server: receipt path required\n");
  process.exit(2);
}

function record(direction, payload) {
  appendFileSync(receiptPath, JSON.stringify({ t: new Date().toISOString(), pid: process.pid, direction, payload }) + "\n");
}

function send(message) {
  record("out", message);
  process.stdout.write(JSON.stringify(message) + "\n");
}

const TOOLS = [
  {
    name: "echo_marker",
    description: "Echo a fixed marker string. Test tool.",
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
      additionalProperties: false
    }
  },
  {
    name: "write_receipt",
    description: "Record a marker on the server side and return it. Test tool.",
    inputSchema: {
      type: "object",
      properties: { marker: { type: "string" } },
      required: ["marker"],
      additionalProperties: false
    }
  }
];

const RESOURCES = [
  { uri: "hostcov://fixture/alpha", name: "alpha", mimeType: "text/plain", description: "Fixture resource alpha" },
  { uri: "hostcov://fixture/beta", name: "beta", mimeType: "text/plain", description: "Fixture resource beta" }
];
const TEMPLATES = [
  { uriTemplate: "hostcov://fixture/{name}", name: "fixture-item", mimeType: "text/plain" }
];

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  for (;;) {
    const newline = buffer.indexOf("\n");
    if (newline < 0) break;
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line.length === 0) continue;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      record("in-unparsable", { line });
      continue;
    }
    record("in", message);
    handle(message);
  }
});

function reply(id, result) {
  send({ jsonrpc: "2.0", id, result });
}
function replyError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function handle(message) {
  const { id, method, params } = message;
  const isRequest = id !== undefined && id !== null;
  switch (method) {
    case "server/discover":
      return replyError(id, -32601, "server/discover not implemented by hostcov fixture");
    case "initialize":
      return reply(id, {
        protocolVersion: "2025-11-25",
        capabilities: { tools: { listChanged: false }, resources: { listChanged: false, subscribe: false } },
        serverInfo: { name: "hostcov-mcp", version: "1.0.0" },
        instructions: "hostcov fixture server"
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return;
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const name = params?.name;
      const args = params?.arguments ?? {};
      record("tool-call", { name, arguments: args });
      if (name === "echo_marker") {
        return reply(id, { content: [{ type: "text", text: "echo:" + String(args.marker ?? "") }] });
      }
      if (name === "write_receipt") {
        return reply(id, {
          content: [{ type: "text", text: "receipt:" + String(args.marker ?? "") }],
          structuredContent: { marker: args.marker ?? null }
        });
      }
      return replyError(id, -32602, "unknown tool " + String(name));
    }
    case "resources/list":
      return reply(id, { resources: RESOURCES });
    case "resources/templates/list":
      return reply(id, { resourceTemplates: TEMPLATES });
    case "resources/read": {
      const uri = params?.uri;
      record("resource-read", { uri });
      const hit = RESOURCES.find((entry) => entry.uri === uri);
      if (hit === undefined) return replyError(id, -32002, "resource not found: " + String(uri));
      return reply(id, { contents: [{ uri, mimeType: "text/plain", text: "body:" + hit.name }] });
    }
    default:
      if (isRequest) return replyError(id, -32601, "method not found: " + String(method));
      return;
  }
}
