/** Browser response readers validate values before giving them a static type. */
export type Decoder<T> = (value: unknown) => T;
export type JsonObject = Readonly<Record<string, unknown>>;

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function object(value: unknown): JsonObject {
  if (!isObject(value)) throw new TypeError('expected an object');
  return value;
}

export function text(value: unknown): string {
  if (typeof value !== 'string') throw new TypeError('expected a string');
  return value;
}

export function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError('expected a finite number');
  return value;
}

export function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new TypeError('expected a boolean');
  return value;
}

export function field<T>(
  source: JsonObject,
  name: string,
  decode: Decoder<T>,
): T {
  try {
    return decode(source[name]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new TypeError(`${name}: ${message}`, { cause: error });
  }
}

export function array<T>(decode: Decoder<T>): Decoder<readonly T[]> {
  return (value) => {
    if (!Array.isArray(value)) throw new TypeError('expected an array');
    const items: readonly unknown[] = value;
    return items.map((item, index) => {
      try {
        return decode(item);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new TypeError(`[${String(index)}]: ${message}`, { cause: error });
      }
    });
  };
}

export function nullable<T>(decode: Decoder<T>): Decoder<T | null> {
  return (value) => (value === null ? null : decode(value));
}

export function optional<T>(decode: Decoder<T>): Decoder<T | undefined> {
  return (value) => (value === undefined ? undefined : decode(value));
}

export function choice<const T extends string>(
  ...options: readonly T[]
): Decoder<T> {
  return (value) => {
    const selected = options.find((option) => option === value);
    if (selected === undefined)
      throw new TypeError(`expected one of: ${options.join(', ')}`);
    return selected;
  };
}

export const strings = array(text);
export const unknownValue = (value: unknown): unknown => value;
