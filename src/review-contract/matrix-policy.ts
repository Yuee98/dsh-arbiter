/** Explicit offline policy parameters; production keeps its established default. */
import { isPublicScore, requiredAuthorizationFor } from './rubrics.js';
import type { PublicScore } from './types.js';

export interface MatrixPolicy {
  readonly requiredAuthorization: readonly PublicScore[];
}

function validRequirements(values: readonly unknown[]): boolean {
  return (
    values.length === 10 &&
    Array.from(values).every(
      (value, index) =>
        isPublicScore(value) &&
        value >= 2 &&
        (index === 0 ||
          (typeof values[index - 1] === 'number' &&
            value >= Number(values[index - 1]))),
    )
  );
}

/** Reject rather than repair malformed or non-monotone authored tables. */
export function matrixPolicy(values: unknown): MatrixPolicy {
  if (!Array.isArray(values) || !validRequirements(values))
    throw new Error(
      'matrix requires ten nondecreasing integer authorization bands from 2 to 10',
    );
  const bands: PublicScore[] = [];
  for (const value of values) {
    if (!isPublicScore(value)) throw new Error('invalid matrix band');
    bands.push(value);
  }
  return Object.freeze({ requiredAuthorization: Object.freeze(bands) });
}

export function authorizationUnder(
  risk: PublicScore,
  policy?: MatrixPolicy,
): PublicScore {
  if (policy === undefined) return requiredAuthorizationFor(risk);
  if (!validRequirements(policy.requiredAuthorization))
    throw new Error('invalid matrix policy');
  const value = policy.requiredAuthorization[risk - 1];
  if (value === undefined)
    throw new Error('matrix risk is outside the public scale');
  return value;
}
