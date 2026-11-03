/** Authored finite matrices, not inferred policies or a search space. */
import {
  matrixPolicy,
  requiredAuthorizationFor,
} from '../../../src/review-contract/index.js';
import type {
  MatrixPolicy,
  PublicScore,
} from '../../../src/review-contract/index.js';
import { digestOf } from '../data/hash.js';

export interface ReplayMatrix extends MatrixPolicy {
  readonly id: string;
}
const SCORES: readonly PublicScore[] = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];

export function readReplayMatrix(
  value: unknown,
): ReplayMatrix | string | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    return 'matrix must be an object';
  const keys = Object.keys(value);
  if (
    keys.length !== 2 ||
    !keys.includes('id') ||
    !keys.includes('requiredAuthorization')
  )
    return 'matrix accepts exactly id and requiredAuthorization';
  const id: unknown = Reflect.get(value, 'id');
  if (
    typeof id !== 'string' ||
    id.length > 63 ||
    !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(id)
  )
    return 'matrix.id must be a safe lowercase slug of at most 63 characters';
  try {
    const policy = matrixPolicy(Reflect.get(value, 'requiredAuthorization'));
    if (
      SCORES.every(
        (risk, index) =>
          policy.requiredAuthorization[index] ===
          requiredAuthorizationFor(risk),
      )
    )
      return undefined;
    return Object.freeze({
      id,
      requiredAuthorization: policy.requiredAuthorization,
    });
  } catch (error) {
    return error instanceof Error ? error.message : 'invalid matrix';
  }
}

export function matrixDigest(matrix: ReplayMatrix): string {
  return digestOf(matrix.requiredAuthorization);
}
