/**
 * Reading a document a test just wrote.
 *
 * A test that asserts on a file the tool produced has to parse it, and the parsed
 * value is unknown until something says otherwise. Going through the same schema
 * checker the dataset uses means a test cannot quietly depend on a document the
 * real loader would reject — and it keeps the assertion honest, because a narrowed
 * type is only obtained from the schema.
 */

import { readFile } from 'node:fs/promises';

import { compileCheckers } from '../../../evals/src/data/schemas.js';
import type { Checker } from '../../../evals/src/data/schemas.js';

const checkers = await compileCheckers();

/** The schema checkers, compiled once for the whole test run. */
export const schemas = checkers;

/** Read one file and require it to match the schema for its kind. */
export async function readDocument<T>(
  path: string,
  check: Checker<T>,
): Promise<T> {
  const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
  const checked = check(parsed);
  if (!checked.ok) {
    throw new Error(
      `${path} does not match its schema: ${checked.problems.join('; ')}`,
    );
  }
  return checked.document;
}
