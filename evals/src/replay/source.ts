/**
 * Reading one run directory as replay input, and nothing more.
 *
 * A replay's input is a run directory that already exists. So this module reads
 * exactly the surface a report reads — the published artifact reader, the
 * published schemas — and never the executor, the scheduler or a fixture runner.
 * What it adds is the part a replay needs and a report does not: a digest of every
 * document it read, taken from the bytes on disk.
 *
 * Those digests are the reason this module exists. A lineage record that names
 * `records/<cellId>.json` without saying what that file contained cannot be
 * checked later: the file could have been edited between the source run and the
 * replay, and the derived numbers would then describe evidence nobody saved. With
 * the digests, a reader can re-run `sha256sum` on the source and see whether the
 * derivation still applies.
 *
 * Nothing here writes, dispatches or reads a clock.
 */

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ReviewOutcome } from '../../../src/review-contract/index.js';

import { digestOf } from '../data/hash.js';

import { RUN_FILES, readRun, recordPathOf } from '../run/artifact.js';
import { compileRunCheckers } from '../run/schemas.js';
import type { CellRecord, CellState, RunIndex, RunPlan } from '../run/types.js';

import type { ReplaySource, SourceFile } from './types.js';

/** The `sha256:<hex>` digest of a document's bytes exactly as they stand. */
function digestOfBytes(bytes: Buffer): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * The canonical digest of a document as it stands in the bytes that were read.
 *
 * The artifact reader parses the files itself, so its documents and this module's
 * digests are two reads of one directory. Comparing canonical digests is what ties
 * them together: `digestOf` normalises formatting, so this is "the document parsed
 * from these bytes" rather than "these bytes happened to be formatted this way".
 */
function digestOfSnapshot(bytes: Buffer): string | null {
  try {
    const parsed: unknown = JSON.parse(bytes.toString('utf8'));
    return digestOf(parsed);
  } catch {
    return null;
  }
}

/**
 * Why a document the reader produced is not the document these bytes hold.
 *
 * This is the check that makes a lineage's digest mean something. Without it, the
 * digest and the derivation are two independent reads: a run still being written, or
 * one being continued, can hand the reader an index from before a write and this
 * module the plan from after it, and the derived numbers would then describe bytes
 * that the lineage does not name. A reader who re-hashes the source would see the
 * recorded digest match its own file and conclude the derivation was reproducible.
 */
function snapshotProblem(parts: {
  readonly path: string;
  readonly bytes: Buffer;
  readonly document: unknown;
}): string | null {
  const snapshot = digestOfSnapshot(parts.bytes);
  if (snapshot === null) {
    return `${parts.path} is not valid JSON, so the document the replay read cannot be tied to the bytes it hashed`;
  }
  const parsed = digestOf(parts.document);
  if (snapshot !== parsed) {
    return `${parts.path} changed while it was being read: the digest the lineage would record is of different bytes than the document the derivation uses`;
  }
  return null;
}

/** One record file, with the bytes it was read at. */
export interface SourcedRecord {
  readonly record: CellRecord;
  /** Path relative to the run directory, as the index names it. */
  readonly path: string;
  readonly digest: string;
}

/** A run directory the replay can read, or why it cannot. */
export type SourceRead =
  | {
      readonly ok: true;
      readonly directory: string;
      readonly plan: RunPlan;
      readonly index: RunIndex;
      readonly records: ReadonlyMap<string, SourcedRecord>;
      /** Index cells with no record file, which are a state rather than a failure. */
      readonly recordless: readonly CellState[];
      /** The scripted socket, byte for byte, or null for a live run. */
      readonly fixture: Buffer | null;
      readonly source: ReplaySource;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/** Whether a path names a file, without throwing on a missing one. */
async function bytesOrNull(path: string): Promise<Buffer | null> {
  try {
    return await readFile(path);
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return null;
    }
    throw error;
  }
}

/**
 * The versions a source run recorded.
 *
 * Read from the index and copied member by member, so a member this build does not
 * know cannot leak through a spread into a document whose schema forbids it.
 */
function versionsOf(index: RunIndex): ReplaySource['versions'] {
  return {
    contract: index.versions.contract,
    prompt: index.versions.prompt,
    usageMapping: index.versions.usageMapping,
    plan: index.versions.plan,
    artifact: index.versions.artifact,
    implementation: index.versions.implementation,
    node: index.versions.node ?? null,
  };
}

/**
 * Read one run directory for replay.
 *
 * The directory is described the way the caller will see it in the lineage: a path
 * relative to the repository root when the caller pointed inside it, so a lineage
 * document committed beside a report does not carry one machine's absolute path.
 * The absolute path is still what the file reads use, which is why the two are
 * kept apart rather than one being derived from the other.
 */
export async function readSource(parts: {
  readonly directory: string;
  readonly root: string;
  /**
   * A seam called once after the plan has been parsed, before its bytes are hashed.
   *
   * This is the window the snapshot check exists for. A test can only produce it on
   * demand: racing a real writer lands mid-file nearly every time, and a torn document
   * is refused by the JSON parser before this comparison is reached, so the race would
   * test the parser rather than the invariant. Production callers pass nothing.
   */
  readonly duringRead?: () => Promise<void>;
}): Promise<SourceRead> {
  const checkers = await compileRunCheckers();
  const read = await readRun(parts.directory, checkers);
  if (!read.ok) {
    return {
      ok: false,
      problems: read.problems.map(
        (problem) => `${problem.path}: ${problem.message}`,
      ),
    };
  }
  const artifact = read.artifact;
  const files: SourceFile[] = [];
  const record = async (path: string): Promise<Buffer | null> => {
    const bytes = await bytesOrNull(join(parts.directory, path));
    if (bytes !== null) files.push({ path, digest: digestOfBytes(bytes) });
    return bytes;
  };
  // The reader parsed these files itself, so the snapshot check is what makes the
  // artifact and the lineage describe one state of the directory. A run that is still
  // being written, or one being continued, is the case this exists for.
  if (parts.duringRead !== undefined) await parts.duringRead();
  const planBytes = await record(RUN_FILES.plan);
  const indexBytes = await record(RUN_FILES.index);
  const ties: readonly {
    readonly path: string;
    readonly bytes: Buffer | null;
    readonly document: unknown;
  }[] = [
    { path: RUN_FILES.plan, bytes: planBytes, document: artifact.plan },
    { path: RUN_FILES.index, bytes: indexBytes, document: artifact.index },
  ];
  const mismatched: string[] = [];
  for (const tie of ties) {
    if (tie.bytes === null) {
      mismatched.push(`${tie.path} disappeared while the run was being read`);
      continue;
    }
    const problem = snapshotProblem({
      path: tie.path,
      bytes: tie.bytes,
      document: tie.document,
    });
    if (problem !== null) mismatched.push(problem);
  }
  // The index certifies the plan by digest, so a directory whose two documents disagree
  // is not a run a replay can describe: the derivation would use one plan while the
  // lineage reported the index that names the other. That is a different failure from a
  // concurrent write — it can also be a hand-edited plan — and both make the same claim
  // false, so both are refused.
  if (
    planBytes !== null &&
    digestOf(artifact.plan) !== artifact.index.planHash
  ) {
    mismatched.push(
      `${RUN_FILES.plan} does not match the plan digest ${RUN_FILES.index} records (${artifact.index.planHash}); the run's documents disagree about which plan produced it`,
    );
  }
  if (mismatched.length > 0) {
    return { ok: false, problems: mismatched };
  }
  const records = new Map<string, SourcedRecord>();
  for (const entry of artifact.records) {
    const path = recordPathOf(entry.cellId);
    const bytes = await record(path);
    if (bytes === null) {
      // The reader just returned this record, so its file exists. Reaching here
      // means the directory changed under the read, which is not something to
      // paper over: a replay of a half-written run would be a lineage nobody can
      // reproduce.
      return {
        ok: false,
        problems: [
          `${path} disappeared while the run was being read; a replay needs a directory that holds still`,
        ],
      };
    }
    const recordProblem = snapshotProblem({ path, bytes, document: entry });
    if (recordProblem !== null) {
      return { ok: false, problems: [recordProblem] };
    }
    records.set(entry.cellId, {
      record: entry,
      path,
      digest: files[files.length - 1]?.digest ?? digestOfBytes(bytes),
    });
  }
  const fixture = await record(RUN_FILES.fixture);
  files.sort((left, right) =>
    left.path < right.path ? -1 : left.path > right.path ? 1 : 0,
  );
  const planned = new Set(artifact.index.cells.map((cell) => cell.cellId));
  const unplanned = [...records.keys()].filter(
    (cellId) => !planned.has(cellId),
  );
  if (unplanned.length > 0) {
    // A record the index does not plan cannot be placed in the run's cell list, so
    // a replay would silently omit it. Refusing names the files instead.
    return {
      ok: false,
      problems: [
        `${String(unplanned.length)} record(s) name a cell the index does not plan: ${unplanned.join(', ')}`,
      ],
    };
  }
  return {
    ok: true,
    directory: parts.directory,
    plan: artifact.plan,
    index: artifact.index,
    records,
    recordless: artifact.missing,
    fixture,
    source: {
      directory: relativeTo(parts.root, parts.directory),
      runId: artifact.index.runId,
      planHash: artifact.index.planHash,
      dataset: {
        datasetId: artifact.index.dataset.datasetId,
        digest: artifact.index.dataset.digest,
      },
      versions: versionsOf(artifact.index),
      files,
    },
  };
}

/**
 * A path as a lineage should print it.
 *
 * A directory inside the repository is named relative to its root, because that is
 * what a reader can check out and find. A directory outside it keeps its absolute
 * path: pretending a temporary run lives inside the repository would make the
 * lineage point at nothing.
 */
function relativeTo(root: string, path: string): string {
  const normalisedRoot = root.endsWith('/') ? root.slice(0, -1) : root;
  if (!path.startsWith(`${normalisedRoot}/`)) return path;
  return path.slice(normalisedRoot.length + 1);
}

/** The outcome a record holds, for a caller that wants only the decision. */
export function outcomeOf(record: CellRecord): ReviewOutcome | null {
  return record.outcome;
}
