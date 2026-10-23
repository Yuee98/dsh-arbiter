/**
 * Barrier control for the fixture's reviewer holds.
 *
 * Every helper here proves state from the fixture's own files, not from a
 * sleep: `waitStarted` waits for the fixture to record that a specific review
 * began, `release` frees exactly one call, and `waitFinished` waits for that
 * call's reply to be produced.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function barrierDir(caseDir) {
  return join(caseDir, 'barrier');
}

export function startedFile(caseDir, callId) {
  return join(barrierDir(caseDir), `${callId}-started.json`);
}

export function releaseFile(caseDir, callId) {
  return join(barrierDir(caseDir), `${callId}-release`);
}

export function finishedFile(caseDir, callId) {
  return join(barrierDir(caseDir), `${callId}-finished.json`);
}

/** Wait until at least `count` reviews have recorded their start. */
export async function waitStarted(caseDir, count = 1, timeoutMs = 60000) {
  const dir = barrierDir(caseDir);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const files = existsSync(dir)
      ? readdirSync(dir).filter((f) => f.endsWith('-started.json'))
      : [];
    if (files.length >= count) {
      return files.map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
    }
    await sleep(50);
  }
  return [];
}

/** Release exactly one held review. */
export function release(caseDir, callId) {
  writeFileSync(releaseFile(caseDir, callId), 'release\n');
}

/** Wait for that call's reply to be produced (the hold is over). */
export async function waitFinished(caseDir, callId, timeoutMs = 60000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(finishedFile(caseDir, callId))) {
      return JSON.parse(readFileSync(finishedFile(caseDir, callId), 'utf8'));
    }
    await sleep(50);
  }
  return null;
}

/** Read the fixture's own timeline (started / released / agent steps). */
export function barrierTimeline(caseDir) {
  const p = join(barrierDir(caseDir), 'timeline.jsonl');
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Whether a given call is still held (started, not released). */
export function isHeld(caseDir, callId) {
  return existsSync(startedFile(caseDir, callId)) && !existsSync(releaseFile(caseDir, callId));
}
