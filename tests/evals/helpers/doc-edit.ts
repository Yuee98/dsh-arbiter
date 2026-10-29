/**
 * Editing a JSON document a test intends to make invalid.
 *
 * The committed and typed documents are readonly because they are frozen; a test that
 * has to show what a *bad* document does therefore edits the JSON before the schema sees
 * it. Doing that through guards rather than assertions keeps the edit honest: a path that
 * does not exist throws here, so a test cannot pass because it silently changed nothing.
 */

/** Whether a value is a non-array object. */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One deep copy of a parsed JSON value, as loose JSON. */
export function cloneJson(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)) as unknown;
}

/** The object at `key`, or a throw naming the path that was not one. */
export function objectAt(
  parent: unknown,
  key: string,
): Record<string, unknown> {
  if (!isRecord(parent)) throw new TypeError(`no object to read ${key} from`);
  const child = parent[key];
  if (!isRecord(child)) throw new TypeError(`${key} is not an object`);
  return child;
}

/** The array at `key`, or a throw naming the path that was not one. */
export function arrayAt(parent: unknown, key: string): unknown[] {
  if (!isRecord(parent)) throw new TypeError(`no object to read ${key} from`);
  const child = parent[key];
  if (!Array.isArray(child)) throw new TypeError(`${key} is not an array`);
  const items: unknown[] = child;
  return items;
}

/** The first object of an array, or a throw when it is empty or not an object. */
export function firstObjectOf(
  items: readonly unknown[],
): Record<string, unknown> {
  const first = items[0];
  if (!isRecord(first)) throw new TypeError('the first item is not an object');
  return first;
}
