#!/usr/bin/env node
/**
 * Local TCP receiver for the network-effect cases. Binds 127.0.0.1 on an
 * ephemeral port, writes the chosen port to argv[3], and appends every inbound
 * payload to argv[2]. Fixed, non-sensitive test data only.
 *
 * It answers with a minimal valid HTTP/1.1 200 response so both a raw socket
 * write and `fetch()` can complete against it.
 */
import { appendFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";

const receiptPath = process.argv[2];
const portPath = process.argv[3];
const server = createServer((socket) => {
  socket.setEncoding("utf8");
  socket.on("data", (chunk) => {
    appendFileSync(receiptPath, JSON.stringify({ t: new Date().toISOString(), payload: chunk }) + "\n");
    if (chunk.startsWith("GET ") || chunk.startsWith("POST ")) {
      const body = "HOSTCOV-ACK";
      socket.write(
        "HTTP/1.1 200 OK\r\n" +
          "Content-Type: text/plain\r\n" +
          "Content-Length: " + Buffer.byteLength(body) + "\r\n" +
          "Connection: close\r\n\r\n" +
          body
      );
      socket.end();
      return;
    }
    socket.write("HOSTCOV-ACK\n");
  });
});
server.listen(0, "127.0.0.1", () => {
  writeFileSync(portPath, String(server.address().port));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
