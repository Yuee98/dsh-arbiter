/**
 * The run documents' schema checkers.
 *
 * The published JSON Schemas in `evals/schemas/run*.schema.json` are the contract
 * other tools read; this module compiles them so a document only becomes a typed
 * value after its schema accepted it. That is the same rule the dataset documents
 * follow, and it exists for the same reason: these files are written by this
 * repository and read by code this repository does not control, so "the writer
 * meant it" is not evidence of its shape.
 *
 * The checker set is separate from the dataset checkers because the run documents
 * are a different contract with their own versions. Both compile the same schema
 * directory, so a run schema that stopped compiling fails here rather than being
 * skipped.
 */

import { Ajv } from 'ajv';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { ErrorObject, ValidateFunction } from 'ajv';

import { SCHEMA_DIRECTORY } from '../data/schemas.js';
import type { Checked } from '../data/schemas.js';
import type { CellRecord, RunFixture, RunIndex, RunPlan } from './types.js';

const SUFFIX = '.schema.json';
const BASE = 'https://dsh-arbiter.dev/schemas/evals/';

/** Every run document kind's checker. */
export interface RunCheckers {
  readonly plan: (value: unknown) => Checked<RunPlan>;
  readonly index: (value: unknown) => Checked<RunIndex>;
  readonly record: (value: unknown) => Checked<CellRecord>;
  readonly fixture: (value: unknown) => Checked<RunFixture>;
}

/** A readable one-line summary of why a document failed its schema. */
function describe(errors: readonly ErrorObject[] | null | undefined): string {
  if (errors === null || errors === undefined || errors.length === 0) {
    return 'the document does not match its schema';
  }
  return errors
    .map((error) => {
      const where = error.instancePath === '' ? '/' : error.instancePath;
      return `${where} ${error.message ?? 'is invalid'}`;
    })
    .join('; ');
}

/**
 * One compiled validator as a checker.
 *
 * A predicate's body is not required to prove the narrowing it declares, which is
 * the licence this needs: the compiler cannot see inside Ajv and the schema is what
 * decides. Every run document enters the typed world through exactly this.
 */
function checkerOf<T>(
  validator: ValidateFunction<T>,
): (value: unknown) => Checked<T> {
  return (value: unknown): Checked<T> => {
    if (!validator(value))
      return { ok: false, problems: [describe(validator.errors)] };
    return { ok: true, document: value };
  };
}

/** Compile one registered run validator. */
function compile<T>(ajv: Ajv, name: string): ValidateFunction<T> {
  const validator: ValidateFunction<T> | undefined = ajv.getSchema<T>(
    `${BASE}${name}${SUFFIX}`,
  );
  if (validator === undefined) {
    throw new Error(`evals run schema ${name}${SUFFIX} did not compile`);
  }
  return validator;
}

/**
 * Compile every schema in the shared schema directory and hand out the run ones.
 *
 * `run-common.schema.json` is a definition file with no document of its own, so it
 * is registered but never handed out — the same rule the dataset checkers follow
 * for `common.schema.json`.
 */
export async function compileRunCheckers(
  directory = SCHEMA_DIRECTORY,
): Promise<RunCheckers> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const names = (await readdir(directory))
    .filter((name) => name.endsWith(SUFFIX))
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    const document: unknown = JSON.parse(
      await readFile(join(directory, name), 'utf8'),
    );
    if (document === null || typeof document !== 'object') {
      throw new TypeError(`evals schema ${name} must be a JSON object`);
    }
    ajv.addSchema(document);
  }
  return {
    plan: checkerOf(compile<RunPlan>(ajv, 'run-plan')),
    index: checkerOf(compile<RunIndex>(ajv, 'run')),
    record: checkerOf(compile<CellRecord>(ajv, 'run-record')),
    fixture: checkerOf(compile<RunFixture>(ajv, 'run-fixture')),
  };
}
