/**
 * Running a real replay in a temporary directory.
 *
 * Every helper here writes real files and runs the real runner and the real
 * replayer, because the claims under test are about directories: the source run is
 * not written to, the derived directory is readable as a run, and the digests in
 * the lineage describe the bytes that were actually there. A helper that handed the
 * replayer an in-memory artifact would exercise a path no person uses — and, worse,
 * would skip exactly the file reads whose absence the offline test depends on.
 */

import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import type {
  ReplayCommand,
  ReplayIo,
} from '../../../evals/src/replay/command.js';
import { replayRun } from '../../../evals/src/replay/command.js';
import { recordPathOf } from '../../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../../evals/src/run/schemas.js';
import type { CellRecord } from '../../../evals/src/run/types.js';

import { REPOSITORY_ROOT, runPlan } from './report-run.js';
import {
  cellIdOf,
  chatTarget,
  decisionAnswer,
  decisionTarget,
  fixtureCell,
  fixtureOf,
  planOf,
} from './run.js';
import type { FixtureResponse } from '../../../evals/src/run/types.js';

/** A file's path and the digest of its contents. */
export interface InventoryEntry {
  readonly path: string;
  readonly digest: string;
}

/** Every file under a directory, with a content digest, sorted by path. */
export async function inventory(
  directory: string,
): Promise<readonly InventoryEntry[]> {
  const names = (await readdir(directory, { recursive: true })).sort();
  const entries: InventoryEntry[] = [];
  for (const name of names) {
    const path = join(directory, name);
    const info = await stat(path).catch(() => null);
    if (info === null || !info.isFile()) continue;
    entries.push({
      path: name,
      digest: createHash('sha256')
        .update(await readFile(path))
        .digest('hex'),
    });
  }
  return entries;
}

/** The two cases every replay test uses, in the order a plan names them. */
export const CASES = ['read-named-source-file', 'read-repo-index-with-cache'];

/** A chat-only run of two cases, each answering a distinct score pair. */
export async function chatRun(
  directory: string,
  answers: readonly {
    readonly cellId: string;
    readonly text: string;
    readonly usage?: unknown;
  }[],
): Promise<string> {
  return runPlan({
    directory,
    plan: planOf({
      caseIds: CASES,
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf(
      Object.fromEntries(
        answers.map((answer) => [
          answer.cellId,
          fixtureCell({
            chat: [
              {
                kind: 'text',
                text: answer.text,
                ...(answer.usage === undefined ? {} : { usage: answer.usage }),
              },
            ],
          }),
        ]),
      ),
    ),
  });
}

/** The cell id of one chat case. */
export function chatCellOf(caseId: string, targetId = 'chat-a'): string {
  return cellIdOf({ caseId, targetId, protocol: 'chat' });
}

/** The cell id of one decision case. */
export function decisionCellOf(
  caseId: string,
  targetId = 'decision-a',
): string {
  return cellIdOf({ caseId, targetId, protocol: 'decision' });
}

/** A decision response for one case, from two sparse distributions. */
export function decisionForCase(
  risk: Readonly<Record<string, number>>,
  authorization: Readonly<Record<string, number>>,
  usage?: unknown,
): FixtureResponse {
  return decisionAnswer(
    risk,
    authorization,
    usage === undefined ? {} : { usage },
  );
}

/** A decision run of the cases a test scripts. */
export async function decisionRun(
  directory: string,
  cells: Readonly<Record<string, FixtureResponse>>,
): Promise<string> {
  return runPlan({
    directory,
    plan: planOf({
      caseIds: Object.keys(cells).map((cellId) => cellId.split('~')[0] ?? ''),
      protocols: ['decision'],
      targets: [decisionTarget()],
    }),
    fixture: fixtureOf(
      Object.fromEntries(
        Object.keys(cells).map((cellId) => [
          cellId,
          fixtureCell({
            decision: [cells[cellId] ?? { status: 500, body: '' }],
          }),
        ]),
      ),
    ),
  });
}

/** What one replay invocation produced. */
export interface ReplayOutcome {
  readonly code: number;
  readonly out: readonly string[];
  readonly err: readonly string[];
}

/** Run the replay command with the given flags, capturing its streams. */
export async function replay(parts: {
  readonly directory: string;
  readonly output: string | null;
  readonly variants?: string | null;
  readonly answer?: string | null;
  readonly thresholdRisk?: string | null;
  readonly thresholdAuthorization?: string | null;
  readonly mode?: string | null;
  readonly channel?: string | null;
  readonly force?: boolean;
}): Promise<ReplayOutcome> {
  const out: string[] = [];
  const err: string[] = [];
  const io: ReplayIo = {
    root: REPOSITORY_ROOT,
    out: (line) => out.push(line),
    err: (line) => err.push(line),
  };
  const command: ReplayCommand = {
    directory: parts.directory,
    variants: parts.variants ?? null,
    output: parts.output,
    force: parts.force ?? false,
    flags: {
      answer: parts.answer ?? null,
      thresholdRisk: parts.thresholdRisk ?? null,
      thresholdAuthorization: parts.thresholdAuthorization ?? null,
      mode: parts.mode ?? null,
      channel: parts.channel ?? null,
    },
  };
  const code = await replayRun(io, command);
  return { code, out, err };
}

/** A parsed JSON object, as a test may walk it. */
export type JsonObject = Readonly<Record<string, unknown>>;

/** A plain object, for narrowing without a cast. */
export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Read one JSON object.
 *
 * A test reads documents the tool wrote, so the parsed value is unknown until
 * something establishes its shape. This narrows only "it is an object"; every member
 * is then fetched through a path accessor below, which fails loudly on the path it
 * could not find. That is deliberately stricter than a type assertion: an assertion
 * would let a document that lost the member a test meant to check keep passing,
 * because the assertion is checked by the compiler rather than by the file.
 */
export async function readJson(path: string): Promise<JsonObject> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (!isObject(parsed)) throw new TypeError(`${path} is not a JSON object`);
  return parsed;
}

/** The value at a dotted path, for a caller that narrows it itself. */
export function at(document: JsonObject, path: string): unknown {
  let current: unknown = document;
  for (const key of path.split('.')) {
    if (!isObject(current) || !(key in current)) {
      throw new Error(`no ${path}: the document has no ${key}`);
    }
    current = current[key];
  }
  return current;
}

/** The object at a dotted path. */
export function objectAt(document: JsonObject, path: string): JsonObject {
  const value = at(document, path);
  if (!isObject(value)) throw new TypeError(`${path} is not an object`);
  return value;
}

/** The objects in the array at a dotted path. */
export function objectsAt(
  document: JsonObject,
  path: string,
): readonly JsonObject[] {
  const value = at(document, path);
  if (!Array.isArray(value)) throw new TypeError(`${path} is not an array`);
  return value.map((entry, index) => {
    if (!isObject(entry)) {
      throw new TypeError(`${path}[${String(index)}] is not an object`);
    }
    return entry;
  });
}

/** The string at a dotted path. */
export function textAt(document: JsonObject, path: string): string {
  const value = at(document, path);
  if (typeof value !== 'string') throw new TypeError(`${path} is not a string`);
  return value;
}

/** The number at a dotted path. */
export function numberAt(document: JsonObject, path: string): number {
  const value = at(document, path);
  if (typeof value !== 'number') throw new TypeError(`${path} is not a number`);
  return value;
}

/** The string at a dotted path, or null when the member is null. */
export function textOrNullAt(
  document: JsonObject,
  path: string,
): string | null {
  const value = at(document, path);
  if (value === null) return null;
  if (typeof value !== 'string') {
    throw new TypeError(`${path} is not a string or null`);
  }
  return value;
}

/**
 * One cell record, read through the published schema.
 *
 * The record checker is what establishes the type, so a test cannot assert on a
 * document the real reader would refuse — the same reason `helpers/documents.ts`
 * exists for the dataset side.
 */
export async function recordOf(path: string): Promise<CellRecord> {
  const checkers = await compileRunCheckers();
  const checked = checkers.record(JSON.parse(await readFile(path, 'utf8')));
  if (!checked.ok) {
    throw new Error(
      `${path} does not match its schema: ${checked.problems.join('; ')}`,
    );
  }
  return checked.document;
}

/** The stored record of one cell, from a run or a derived directory. */
export async function cellRecordOf(
  directory: string,
  cellId: string,
): Promise<CellRecord> {
  return recordOf(join(directory, recordPathOf(cellId)));
}

/** The strings in the array at a dotted path. */
export function listTextAt(
  document: JsonObject,
  path: string,
): readonly string[] {
  const value = at(document, path);
  if (!Array.isArray(value)) throw new TypeError(`${path} is not an array`);
  return value.map((entry, index) => {
    if (typeof entry !== 'string') {
      throw new TypeError(`${path}[${String(index)}] is not a string`);
    }
    return entry;
  });
}

/** The stamp of one file, in the `sha256:<hex>` form the artifacts use. */
export async function digestOf(path: string): Promise<string> {
  return `sha256:${createHash('sha256')
    .update(await readFile(path))
    .digest('hex')}`;
}

/**
 * A chat run whose only cell ends in a genuine transport failure.
 *
 * The scripted `truncated` stream is what a dropped connection produces: text may
 * arrive and the stream ends with no terminal finish, so the adapter records
 * `failureKind: 'transport'` and no usage. A test that wanted a transport failure and
 * scripted a successful answer would prove nothing about the failure path, which is
 * why this helper exists rather than an inline fixture.
 */
export async function truncatedChatRun(directory: string): Promise<string> {
  return runPlan({
    directory,
    plan: planOf({
      // One case only, so the derived totals count the failure and nothing else: a
      // second planned cell without a fixture would be a different disposition.
      caseIds: [CASES[0] ?? ''],
      protocols: ['chat'],
      targets: [chatTarget()],
    }),
    fixture: fixtureOf({
      [chatCellOf(CASES[0] ?? '')]: fixtureCell({
        chat: [{ kind: 'truncated' }],
      }),
    }),
  });
}

/** A chat answer body with two public integers. */
export function chatText(risk: number, authorization: number): string {
  return JSON.stringify({ risk, authorization });
}
