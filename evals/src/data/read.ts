/**
 * Loading the evals documents from a dataset directory.
 *
 * Reading and checking are deliberately separate: this module only finds files and
 * parses them as JSON, and `inspect.ts` decides whether what came back is a usable
 * dataset. Every document keeps its dataset-relative path, so a later problem can
 * name the file a person has to edit rather than an array index.
 *
 * Nothing here narrows a parsed value to a declared type. A file a person can edit
 * is unknown until a schema says otherwise, and the schema check is what produces
 * the typed value — asserting it here would make every later check advisory.
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** One parsed document together with the file it came from. */
export interface Sourced<T = unknown> {
  readonly path: string;
  readonly document: T;
}

/** One file that could not be read or parsed at all. */
export interface ReadProblem {
  readonly path: string;
  readonly message: string;
}

/** What a dataset directory contained, before any checking. */
export interface RawDataset {
  /** `manifest.json`, or null when it is absent or unparsable. */
  readonly manifest: Sourced | null;
  readonly cases: readonly Sourced[];
  readonly labels: readonly Sourced[];
  readonly reviews: readonly Sourced[];
  readonly problems: readonly ReadProblem[];
}

const JSON_EXTENSION = '.json';

/** The base name of a document file, without its extension. */
export function documentName(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  return name.slice(0, name.length - JSON_EXTENSION.length);
}

/** Whether a directory entry is one of the documents this loader reads. */
function isJson(name: string): boolean {
  return name.endsWith(JSON_EXTENSION);
}

/** Whether a read failure is simply "this file is not there". */
function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function parseJson(path: string): Promise<unknown> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissing(error))
      throw new Error(`${path} does not exist`, { cause: error });
    throw error;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    // The parser's own message names the offset, which is what lets an editor that
    // wrote a trailing comma be found; keep it and add the file in front.
    const cause = error instanceof Error ? error.message : String(error);
    throw new SyntaxError(`${path}: ${cause}`, { cause: error });
  }
}

/** The `.json` files directly inside one directory, sorted for stable output. */
async function jsonFiles(directory: string): Promise<readonly string[]> {
  let names: readonly string[];
  try {
    names = (await readdir(directory)).filter(isJson);
  } catch (error) {
    // A dataset with no labels yet is a normal interim state, not a fault.
    if (isMissing(error)) return [];
    throw error;
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

interface Collection {
  readonly items: readonly Sourced[];
  readonly problems: readonly ReadProblem[];
}

/** Read every document in one subdirectory, keeping per-file failures. */
async function readCollection(
  dataset: string,
  directory: string,
): Promise<Collection> {
  const items: Sourced[] = [];
  const problems: ReadProblem[] = [];
  for (const name of await jsonFiles(join(dataset, directory))) {
    const path = `${directory}/${name}`;
    try {
      items.push({
        path,
        document: await parseJson(join(dataset, directory, name)),
      });
    } catch (error) {
      problems.push({
        path,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { items, problems };
}

/**
 * Read one dataset directory.
 *
 * A missing `cases/` directory is not thrown on: it means the dataset holds no
 * cases yet, and the inspector reports that as its own problem so even a skeleton
 * produces a readable list of what is missing.
 */
export async function readDataset(dataset: string): Promise<RawDataset> {
  const problems: ReadProblem[] = [];
  let manifest: Sourced | null = null;
  try {
    manifest = {
      path: 'manifest.json',
      document: await parseJson(join(dataset, 'manifest.json')),
    };
  } catch (error) {
    problems.push({
      path: 'manifest.json',
      message: error instanceof Error ? error.message : String(error),
    });
  }
  const cases = await readCollection(dataset, 'cases');
  const labels = await readCollection(dataset, 'labels');
  const reviews = await readCollection(dataset, 'reviews');
  return {
    manifest,
    cases: cases.items,
    labels: labels.items,
    reviews: reviews.items,
    problems: [
      ...problems,
      ...cases.problems,
      ...labels.problems,
      ...reviews.problems,
    ],
  };
}
