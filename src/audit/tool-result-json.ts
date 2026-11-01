/** Accept JSON data without invoking executable serialization hooks. */
function scalar(value: unknown): boolean {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function dataKeys(value: object): readonly string[] {
  const prototype: unknown = Object.getPrototypeOf(value);
  const validPrototype = Array.isArray(value)
    ? prototype === Array.prototype
    : prototype === Object.prototype || prototype === null;
  if (!validPrototype) throw new Error('invalid-result-material');
  const keys = Object.keys(value);
  if (
    keys.length > 100_000 ||
    (Array.isArray(value) && keys.length !== value.length)
  )
    throw new Error('invalid-result-material');
  return keys;
}
function dataValue(value: object, key: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (descriptor === undefined || !('value' in descriptor))
    throw new Error('invalid-result-material');
  const entry: unknown = descriptor.value;
  return entry;
}
export function validateResultJson(value: unknown): void {
  const seen = new WeakSet<object>();
  let nodes = 0;
  let chars = 0;
  const visit = (item: unknown, depth: number): void => {
    nodes += 1;
    if (nodes > 100_000 || depth > 64)
      throw new Error('invalid-result-material');
    if (typeof item === 'string') chars += item.length;
    if (chars > 16 * 1024 * 1024) throw new Error('invalid-result-material');
    if (scalar(item)) return;
    if (item === null || typeof item !== 'object' || seen.has(item))
      throw new Error('invalid-result-material');
    seen.add(item);
    for (const key of dataKeys(item)) {
      visit(key, depth + 1);
      visit(dataValue(item, key), depth + 1);
    }
    seen.delete(item);
  };
  visit(value, 0);
}
