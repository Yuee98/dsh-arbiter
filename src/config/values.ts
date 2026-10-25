import type { ConfigError } from '../types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Values present in a document are validated strictly.
 *
 * Defaults apply to absent values only: a supplied field with the wrong type is
 * an error, never a silent permissive fallback. That matters most for security
 * fields such as `enabled` and a rule's agent scope, where a typo would
 * otherwise turn a restricted rule into a broader or active one.
 */
export function asString(
  value: unknown,
  fallback: string,
  path: string,
  errors: ConfigError[],
): string {
  if (value === undefined) return fallback;
  if (typeof value === 'string') return value;
  errors.push({ path, message: 'must be a string', code: 'type.string' });
  return fallback;
}

export function asBoolean(
  value: unknown,
  fallback: boolean,
  path: string,
  errors: ConfigError[],
): boolean {
  if (value === undefined) return fallback;
  if (typeof value === 'boolean') return value;
  errors.push({ path, message: 'must be a boolean', code: 'type.boolean' });
  return fallback;
}

export function asNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
  errors: ConfigError[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({
      path,
      message: 'must be a finite number',
      code: 'type.number',
    });
    return fallback;
  }
  if (value < min || value > max) {
    errors.push({
      path,
      message: `must be between ${String(min)} and ${String(max)}`,
      code: 'range.number',
      params: { min, max },
    });
    return fallback;
  }
  return value;
}

export function asInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
  errors: ConfigError[],
): number {
  const number = asNumber(value, fallback, min, max, path, errors);
  if (!Number.isInteger(number)) {
    errors.push({ path, message: 'must be an integer', code: 'type.integer' });
    return fallback;
  }
  return number;
}

export function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  errors: ConfigError[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string') {
    const match = allowed.find((entry) => entry === value);
    if (match !== undefined) return match;
  }
  errors.push({
    path,
    message: `must be one of ${allowed.join(', ')}`,
    code: 'enum.value',
    params: { values: allowed.join(', ') },
  });
  return fallback;
}
