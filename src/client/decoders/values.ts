import type {
  NormalizationCommand,
  NormalizationDetail,
  NormalizationIssue,
  NormalizationWord,
} from '../../types.js';

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

function normalizationWord(value: unknown): NormalizationWord {
  const source = object(value);
  const wordValue = field(source, 'value', optional(text));
  return {
    raw: field(source, 'raw', text),
    text: field(source, 'text', text),
    status: field(source, 'status', choice('static', 'dynamic')),
    reasons: field(source, 'reasons', strings),
    ...(wordValue === undefined ? {} : { value: wordValue }),
  };
}

function normalizationCommand(value: unknown): NormalizationCommand {
  const source = object(value);
  return {
    text: field(source, 'text', text),
    raw: field(source, 'raw', text),
    words: field(source, 'words', array(normalizationWord)),
  };
}

function normalizationIssue(value: unknown): NormalizationIssue {
  const source = object(value);
  return {
    kind: field(source, 'kind', text),
    message: field(source, 'message', text),
    pos: field(source, 'pos', number),
  };
}

/** Decode the normalization evidence the tester and the call detail both carry. */
export function normalizationDetail(value: unknown): NormalizationDetail {
  const source = object(value);
  return {
    raw: field(source, 'raw', text),
    completeness: field(
      source,
      'completeness',
      choice('complete', 'partial', 'none'),
    ),
    issues: field(source, 'issues', array(normalizationIssue)),
    commands: field(source, 'commands', array(normalizationCommand)),
  };
}

export const strings = array(text);
export const unknownValue = (value: unknown): unknown => value;
