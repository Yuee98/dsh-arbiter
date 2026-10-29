/**
 * The published JSON Schemas, compiled once.
 *
 * The files in `evals/schemas/` are the published form of the contract: they are
 * what an editor validates a hand-written case against, and what this module checks
 * the same file with. Compiling them here — rather than restating their shape in
 * code — is what keeps the two from drifting. The rules a JSON Schema cannot state
 * across files live in `inspect.ts`.
 *
 * A schema validator is turned into a TypeScript type predicate. The predicate is
 * the trust boundary: a document is handed on as a typed value only through it,
 * which is the one place where "the schema accepted this file" becomes "this is a
 * `ReviewCase`".
 */

import { Ajv } from 'ajv';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ErrorObject, ValidateFunction } from 'ajv';

import type {
  AnnotationDocument,
  CaseReviews,
  DatasetManifest,
  ReviewCase,
  ReviewLabel,
  RubricSnapshot,
} from './types.js';

/** The committed schema directory, resolved from this module, not the cwd. */
export const SCHEMA_DIRECTORY = fileURLToPath(
  new URL('../../schemas/', import.meta.url),
);

const SUFFIX = '.schema.json';
const BASE = 'https://dsh-arbiter.dev/schemas/evals/';

/** A document that passed its schema, or the reasons it did not. */
export type Checked<T> =
  | { readonly ok: true; readonly document: T }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * One document kind's checker.
 *
 * The typed document is returned rather than asserted so the caller only holds one
 * after the schema accepted it: these files are hand-edited, which is the whole
 * reason the check exists.
 */
export type Checker<T> = (value: unknown) => Checked<T>;

/** Every document kind's checker. */
export interface Checkers {
  readonly case: Checker<ReviewCase>;
  readonly label: Checker<ReviewLabel>;
  readonly reviews: Checker<CaseReviews>;
  readonly manifest: Checker<DatasetManifest>;
  readonly annotation: Checker<AnnotationDocument>;
  readonly rubric: Checker<RubricSnapshot>;
}

/**
 * A type predicate backed by Ajv.
 *
 * A predicate's body is not required to prove the narrowing it declares, which is
 * exactly the licence this needs: the compiler cannot see inside Ajv and the schema
 * is what decides. Every document enters the typed world through this one function.
 */
function predicateOf<T>(
  validator: ValidateFunction<T>,
): (value: unknown) => value is T {
  return (value: unknown): value is T => validator(value);
}

/** A readable one-line summary of why a document failed its schema. */
export function describeErrors(
  errors: readonly ErrorObject[] | null | undefined,
): string {
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

/** One compiled validator as a checker that keeps its error detail. */
function checkerOf<T>(validator: ValidateFunction<T>): Checker<T> {
  const accepts = predicateOf(validator);
  return (value: unknown): Checked<T> => {
    if (!accepts(value)) {
      return { ok: false, problems: [describeErrors(validator.errors)] };
    }
    return { ok: true, document: value };
  };
}

/** The `.json` schema files in one directory, sorted. */
async function schemaNames(directory: string): Promise<readonly string[]> {
  return (await readdir(directory))
    .filter((name) => name.endsWith(SUFFIX))
    .sort((left, right) => left.localeCompare(right));
}

/**
 * Compile every schema in one directory.
 *
 * `common.schema.json` is a definition file with no document of its own, so it is
 * registered but never handed out as a checker.
 */
export async function compileCheckers(
  directory = SCHEMA_DIRECTORY,
): Promise<Checkers> {
  const ajv = new Ajv({ allErrors: true, strict: true });
  for (const name of await schemaNames(directory)) {
    const document: unknown = JSON.parse(
      await readFile(join(directory, name), 'utf8'),
    );
    if (document === null || typeof document !== 'object') {
      throw new TypeError(`evals schema ${name} must be a JSON object`);
    }
    ajv.addSchema(document);
  }
  return {
    case: checkerOf(compile<ReviewCase>(ajv, 'case')),
    label: checkerOf(compile<ReviewLabel>(ajv, 'label')),
    reviews: checkerOf(compile<CaseReviews>(ajv, 'reviews')),
    manifest: checkerOf(compile<DatasetManifest>(ajv, 'manifest')),
    annotation: checkerOf(compile<AnnotationDocument>(ajv, 'annotation')),
    rubric: checkerOf(compile<RubricSnapshot>(ajv, 'rubric')),
  };
}

/**
 * One registered validator.
 *
 * A schema that does not compile is a defect in this repository rather than a
 * problem with a dataset, so it stops the run instead of being reported as data.
 */
function compile<T>(ajv: Ajv, name: string): ValidateFunction<T> {
  const validator: ValidateFunction<T> | undefined = ajv.getSchema<T>(
    `${BASE}${name}${SUFFIX}`,
  );
  if (validator === undefined) {
    throw new Error(`evals schema ${name}${SUFFIX} did not compile`);
  }
  return validator;
}
