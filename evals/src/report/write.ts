/**
 * The three output documents one report produces, and where they go.
 *
 * A report is one document rendered three ways rather than three documents that could
 * disagree. The JSON is the report itself, serialised with sorted keys and no incidental
 * whitespace decisions, so two rebuilds of one artifact are byte-identical and a diff
 * shows only what actually changed. The Markdown and HTML are renderings of that same
 * value, written from it rather than from the artifact a second time.
 *
 * The writer refuses to overwrite an existing file unless the caller asks for it. A
 * report is evidence, and silently replacing the evidence a previous run produced is the
 * one thing an offline rebuild must not do — so the default is to fail rather than to
 * clobber, and `--force` is the explicit override.
 *
 * Nothing here reads the clock: the files' contents are a function of the artifact and
 * the settings, and the only timestamp in them is the run's own `updatedAt`.
 */

import { readlinkSync, realpathSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  posix,
  resolve,
} from 'node:path';

import type { EvaluationReport } from '../metrics/types.js';
import { renderHtml } from './html.js';
import { renderMarkdown } from './markdown.js';

/** The three files a report is written as, named by their extension. */
export const REPORT_FILES = {
  json: '.json',
  markdown: '.md',
  html: '.html',
} as const;

/** One rendered document, before it is written. */
export interface RenderedReport {
  readonly json: string;
  readonly markdown: string;
  readonly html: string;
}

/**
 * Serialise a value with sorted keys.
 *
 * The report's own builders already order their lists, but object keys come from
 * wherever the value was constructed, and `JSON.stringify` preserves insertion order.
 * Sorting here means a member added in a later version appears in a stable place instead
 * of wherever the code happened to set it, which is what keeps a rebuild's diff readable.
 */
function canonical(value: unknown, indent = 0): string {
  const padding = ' '.repeat(indent);
  const inner = ' '.repeat(indent + 2);
  if (value === null) return 'null';
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'number') {
    // JSON has no NaN or Infinity; a non-finite number here is a defect in a figure,
    // and writing `null` is the honest representation of "this is not a number".
    return Number.isFinite(value) ? JSON.stringify(value) : 'null';
  }
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) {
    if (value.length === 0) return '[]';
    return `[\n${value.map((item) => `${inner}${canonical(item, indent + 2)}`).join(',\n')}\n${padding}]`;
  }
  if (typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    if (entries.length === 0) return '{}';
    return `{\n${entries
      .map(
        ([key, item]) =>
          `${inner}${JSON.stringify(key)}: ${canonical(item, indent + 2)}`,
      )
      .join(',\n')}\n${padding}}`;
  }
  return 'null';
}

/**
 * Render one report as its three documents.
 *
 * The JSON is the report, not a summary of it: every figure the Markdown prints is in it,
 * including the per-cell evidence and the differences. That is what makes a downstream
 * consumer — a later comparison, the replay task — able to work from the JSON alone
 * rather than parsing a table.
 */
export function renderReport(report: EvaluationReport): RenderedReport {
  return {
    json: `${canonical(report)}\n`,
    markdown: renderMarkdown(report),
    html: renderHtml(report),
  };
}

/** What one write produced. */
export interface WrittenReport {
  readonly json: string;
  readonly markdown: string;
  readonly html: string;
  readonly report: EvaluationReport;
}

/** A write that failed because a file already exists. */
export interface WriteConflict {
  readonly ok: false;
  readonly problems: readonly string[];
}

/** A write that succeeded. */
export interface WriteSuccess {
  readonly ok: true;
  readonly written: WrittenReport;
}

/**
 * The paths a report's three documents occupy.
 *
 * Exported so the command can refuse a destination before reading anything: a prefix that
 * lands on the run's own documents is not a place a report may be written, and discovering
 * that after the read would mean the source was already open for a write.
 */
export function reportPathsOf(prefix: string): {
  readonly json: string;
  readonly markdown: string;
  readonly html: string;
} {
  return {
    json: `${prefix}${REPORT_FILES.json}`,
    markdown: `${prefix}${REPORT_FILES.markdown}`,
    html: `${prefix}${REPORT_FILES.html}`,
  };
}

/**
 * One thing a report reads and therefore may not overwrite.
 *
 * A path and whether it denotes a directory. Keeping the distinction explicit is what stops
 * the two cases being conflated: a report's default destination is *inside* the run
 * directory, which is correct, while a destination equal to one of the run's own documents is
 * not.
 */
export interface EvidencePath {
  readonly path: string;
  readonly kind: 'file' | 'directory';
}

/**
 * The destinations that would overwrite evidence this report reads.
 *
 * A report reads a run's `plan.json`, `index.json`, `records/*` and fixture, and (optionally)
 * a dataset's `cases/`, `labels/` and `reviews/`. Every one of those is what the report
 * describes, so writing over it would let an ostensibly read-only operation destroy the
 * artifact it was reporting on. `--force` exists to regenerate a *report*, which is why the
 * refusal applies even when it is set.
 *
 * A directory match is prefix-based, because a record is addressed by cell id and a report
 * must not be able to land on `records/<cellId>.json` by choosing a clever prefix. A file
 * match is exact: the run's own `plan.json` is protected, while `run/report.json` — the
 * default destination — is not.
 */
export function destinationsInside(
  paths: readonly string[],
  evidence: readonly EvidencePath[],
): readonly string[] {
  return paths.filter(
    (path) => !resolvesOutside(path, evidence) || collides(path, evidence),
  );
}

/**
 * Whether this destination is provably outside every protected path.
 *
 * A destination whose own resolution failed is not provably anything: the operating system may
 * still follow it into evidence. A protected path that fails to resolve is a different matter
 * — that is the *evidence* being unreachable, and refusing every write because a dataset holds
 * a cyclic directory would make a damaged dataset unreportable. So only the destination's
 * resolution is a condition of writing.
 */
function resolvesOutside(
  path: string,
  evidence: readonly EvidencePath[],
): boolean {
  // Only the destination's own resolution matters. A protected path that fails to resolve is
  // the *evidence* being unreachable — a dataset with a cyclic directory — and refusing every
  // write because of that would make a damaged dataset unreportable.
  return evidence.length === 0 ? true : resolvePath(path).ok;
}

/** Whether a destination that did resolve names a protected path or sits inside one. */
function collides(path: string, evidence: readonly EvidencePath[]): boolean {
  const resolved = resolvePath(path);
  if (!resolved.ok) return true;
  return evidence.some((entry) => {
    const protectedPath = resolvedEvidence(entry);
    if (protectedPath === null) return false;
    if (entry.kind === 'file') return resolved.path === protectedPath;
    // A directory match is exact or prefix-with-separator, so `/run` does not match
    // `/runaway`.
    return (
      resolved.path === protectedPath ||
      resolved.path.startsWith(`${protectedPath}${posix.sep}`)
    );
  });
}

/**
 * One protected path, resolved when it can be.
 *
 * A protected path that cannot be resolved is skipped rather than treated as matching
 * everything: the evidence itself is unreachable, which the report already says in its notes,
 * and a guard that failed closed on the evidence side would refuse to write any report about a
 * dataset with a cyclic directory.
 */
function resolvedEvidence(entry: EvidencePath): string | null {
  const resolved = resolvePath(entry.path);
  return resolved.ok ? resolved.path : null;
}

/**
 * One path with every symbolic link in it resolved, whether or not the link's target exists.
 *
 * `realpath` answers only for a path that resolves to something. Two shapes must still be
 * compared as the evidence they point at:
 *
 *   - a *dangling* link. `writeFile` follows it and creates the target, so a destination that
 *     is a link into protected evidence would modify that evidence even though neither spelling
 *     exists as a file.
 *   - a destination whose own name is new but whose directory is a link. Resolving the parent
 *     is enough, and it is what makes `--out alias/report` compare equal to the real directory.
 *
 * Resolution can fail, and failure is a third answer rather than a silent "outside". A cyclic
 * link, or a chain longer than `MAX_LINK_HOPS`, leaves a path the operating system can still
 * follow: a 34-link chain is perfectly writable, and treating the point where this walk gave up
 * as proof the destination is harmless would let the write land inside protected evidence. So
 * the caller is told resolution failed, and a containment check refuses what it cannot resolve.
 */
function resolvePath(path: string): ResolvedPath {
  return resolveWithCycleGuard(path, new Set<string>(), 0);
}

/** A path this module could resolve, or the reason it could not. */
type ResolvedPath =
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: string };

/** How many link hops a destination may take before it is treated as unresolvable. */
const MAX_LINK_HOPS = 32;

/** The resolver's body, carrying the visited set and hop count across one traversal. */
function resolveWithCycleGuard(
  path: string,
  visited: Set<string>,
  hops: number,
): ResolvedPath {
  const normalised = normalize(path);
  if (visited.has(normalised)) {
    return { ok: false, reason: `${normalised} links back to itself` };
  }
  if (hops > MAX_LINK_HOPS) {
    return {
      ok: false,
      reason: `${normalised} needs more than ${String(MAX_LINK_HOPS)} link hops`,
    };
  }
  visited.add(normalised);
  try {
    return { ok: true, path: normalize(realpathSync(normalised)) };
  } catch {
    // Nothing resolves here: fall through and resolve the path by parts.
  }
  const parent = dirname(normalised);
  const leaf = basename(normalised);
  const resolvedParent =
    parent === normalised
      ? { ok: true as const, path: normalised }
      : resolveWithCycleGuard(parent, visited, hops);
  if (!resolvedParent.ok) return resolvedParent;
  const candidate = join(resolvedParent.path, leaf);
  const target = linkTargetOf(candidate);
  if (target === null) return { ok: true, path: candidate };
  const absolute = isAbsolute(target)
    ? target
    : resolve(resolvedParent.path, target);
  return resolveWithCycleGuard(absolute, visited, hops + 1);
}

/**
 * The target a symbolic link names, or null when this path is not a link.
 *
 * A dangling link is the case that motivated this: `writeFile` follows it and creates the
 * target, so a destination that is a link into protected evidence must be refused even though
 * neither the link's own path nor its target exists as a file.
 */
export function linkTargetOf(path: string): string | null {
  try {
    return readlinkSync(path);
  } catch {
    return null;
  }
}

/**
 * Write the three documents beside one prefix.
 *
 * `prefix` is a path without an extension: `validation/review-quality/run-a/report`
 * produces `report.json`, `report.md` and `report.html`. The three are written together
 * because a reader who has the Markdown without the JSON cannot check a figure, and one
 * that failed midway would be worse than one that never started — so every check covers all
 * three before the first write.
 *
 * `protectedDirectories` names the directories whose contents are evidence. A destination
 * inside one is refused even with `force`, because `force` is permission to replace a report,
 * not permission to overwrite the run it reports on.
 */
export async function writeReport(parts: {
  readonly prefix: string;
  readonly report: EvaluationReport;
  readonly force: boolean;
  readonly protectedEvidence?: readonly EvidencePath[];
}): Promise<WriteSuccess | WriteConflict> {
  const rendered = renderReport(parts.report);
  const paths = reportPathsOf(parts.prefix);
  const collisions = destinationsInside(
    [paths.json, paths.markdown, paths.html],
    parts.protectedEvidence ?? [],
  );
  if (collisions.length > 0) {
    return {
      ok: false,
      problems: collisions.map(
        (path) =>
          `${path} lies inside evidence this report reads; a report is never written over the run or dataset it describes`,
      ),
    };
  }
  if (!parts.force) {
    const conflicts = await existing(paths);
    if (conflicts.length > 0) {
      return {
        ok: false,
        problems: conflicts.map(
          (path) =>
            `${path} already exists; a report is evidence, so it is not overwritten without --force`,
        ),
      };
    }
  }
  await mkdir(dirname(parts.prefix), { recursive: true });
  await writeFile(paths.json, rendered.json, 'utf8');
  await writeFile(paths.markdown, rendered.markdown, 'utf8');
  await writeFile(paths.html, rendered.html, 'utf8');
  return {
    ok: true,
    written: { ...rendered, report: parts.report },
  };
}

/** The paths among these that already exist. */
async function existing(paths: {
  readonly json: string;
  readonly markdown: string;
  readonly html: string;
}): Promise<readonly string[]> {
  const found: string[] = [];
  for (const path of [paths.json, paths.markdown, paths.html]) {
    if (await isFile(path)) found.push(path);
  }
  return found;
}

/** Whether a path names an existing regular file. */
async function isFile(path: string): Promise<boolean> {
  const { stat } = await import('node:fs/promises');
  try {
    return (await stat(path)).isFile();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      return false;
    }
    throw error;
  }
}

/** Where a run's report belongs when a caller names no prefix. */
export function defaultPrefixOf(directory: string): string {
  return join(directory, 'report');
}
