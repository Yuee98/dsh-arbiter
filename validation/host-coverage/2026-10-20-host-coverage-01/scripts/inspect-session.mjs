#!/usr/bin/env node
/**
 * Decode a persisted DSH session artifact and print selected event types.
 *
 * The JSONL persistence backend writes a CONCATENATED-FRAME Zstandard container,
 * so the public one-shot zstdDecompressSync only yields the first frame. This
 * follows the same frame-scan the host uses (ZSTD magic + frame header + block
 * headers) and decompresses each complete frame independently, using only
 * public Node APIs.
 *
 * usage: node inspect-session.mjs <session.v4.jsonl.zstd> [typePrefix ...]
 */
import { readFileSync } from "node:fs";
import { zstdDecompressSync } from "node:zlib";

const ZSTD_MAGIC = 4247762216;

function scanFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) break;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) throw new Error("invalid zstd frame magic at " + offset);
    offset += 4;
    if (offset === buffer.length) break;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 32) !== 0;
    const checksum = (descriptor & 4) !== 0;
    const dictionaryFlag = descriptor & 3;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) break;
    offset += remainingHeaderBytes;
    let complete = false;
    for (;;) {
      if (buffer.length - offset < 3) break;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 3;
      const blockSize = blockHeader >>> 3;
      const payloadBytes = blockType === 1 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) break;
      offset += payloadBytes;
      if (lastBlock) {
        complete = true;
        break;
      }
    }
    if (!complete) break;
    if (checksum) {
      if (buffer.length - offset < 4) break;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

const file = process.argv[2];
const buffer = readFileSync(file);
const frames = scanFrames(buffer);
const pieces = [];
for (const frame of frames) pieces.push(zstdDecompressSync(buffer.subarray(frame.start, frame.end)));
const text = Buffer.concat(pieces).toString("utf8");
const lines = text.split(/\r?\n/u).filter((line) => line.trim().length > 0);
const events = [];
const counts = {};
for (const line of lines) {
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  counts[event.type] = (counts[event.type] ?? 0) + 1;
  events.push(event);
}
process.stderr.write("frames=" + frames.length + " lines=" + lines.length + "\n");
process.stderr.write(JSON.stringify(counts, null, 2) + "\n");
const prefixes = process.argv.slice(3);
for (const event of events) {
  if (!prefixes.some((prefix) => String(event.type).startsWith(prefix))) continue;
  process.stdout.write(JSON.stringify(event) + "\n");
}
