/**
 * The experiment definition's schema checker.
 *
 * The published run schemas live in `evals/schemas/` and are compiled as one set. The
 * experiment definition is not a run document — it describes a matrix a run will be
 * derived from — so it keeps its own schema beside its own data
 * (`evals/experiments/schema/`) and is compiled here. The one thing it borrows is the
 * run documents' `bounds` definition, by reference, so "what a bound is" is declared
 * once.
 *
 * Both checkers set the same Ajv options and narrow through the same pattern, so a
 * document only becomes a typed value after its schema accepted it. Nothing here calls
 * a model or reads the network.
 */

import { Ajv } from 'ajv';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorObject, ValidateFunction } from 'ajv';

import { SCHEMA_DIRECTORY } from '../data/schemas.js';
import type { Checked } from '../data/schemas.js';
import type { ExperimentDefinition } from './types.js';

/** The committed schema file, resolved from this module rather than from the cwd. */
export const EXPERIMENT_SCHEMA = fileURLToPath(
  new URL('../../experiments/schema/experiment.schema.json', import.meta.url),
);

const BASE = 'https://dsh-arbiter.dev/schemas/evals/';
const SUFFIX = '.schema.json';

/** The definition kinds this module knows. */
export interface ExperimentCheckers {
  readonly experiment: (value: unknown) => Checked<ExperimentDefinition>;
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

/** One compiled validator as a checker. */
function checkerOf<T>(
  validator: ValidateFunction<T>,
): (value: unknown) => Checked<T> {
  return (value: unknown): Checked<T> => {
    if (!validator(value))
      return { ok: false, problems: [describe(validator.errors)] };
    return { ok: true, document: value };
  };
}

/** Read one schema document, refusing anything that is not an object. */
async function readSchema(path: string): Promise<object> {
  const document: unknown = JSON.parse(await readFile(path, 'utf8'));
  if (document === null || typeof document !== 'object') {
    throw new TypeError(`evals schema ${path} must be a JSON object`);
  }
  return document;
}

/**
 * Compile the experiment schema against the published run schemas.
 *
 * The run schemas are registered first so the experiment schema's `$ref` into
 * `run-common.schema.json` resolves to the contract the runner actually enforces.
 * Compiling here as well means a run schema that stopped compiling still fails through
 * the path a person invokes, not only through the run commands' own checkers.
 */
export async function compileExperimentCheckers(
  options: {
    readonly schema?: string;
    readonly sharedSchemas?: string;
  } = {},
): Promise<ExperimentCheckers> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  const shared = options.sharedSchemas ?? SCHEMA_DIRECTORY;
  const names = (await readdir(shared))
    .filter((name) => name.endsWith(SUFFIX))
    .sort((left, right) => left.localeCompare(right));
  for (const name of names) {
    ajv.addSchema(await readSchema(join(shared, name)));
  }
  ajv.addSchema(await readSchema(options.schema ?? EXPERIMENT_SCHEMA));
  const validator = ajv.getSchema<ExperimentDefinition>(
    `${BASE}experiment${SUFFIX}`,
  );
  if (validator === undefined) {
    throw new Error('evals experiment schema did not compile');
  }
  return { experiment: checkerOf(validator) };
}
