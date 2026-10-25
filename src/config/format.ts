/**
 * Explicit configuration formats.
 *
 * A configuration document may declare `format`. Identification never guesses:
 * an unknown or malformed declaration is a configuration error and the caller
 * keeps the current effective configuration. A later rule format registers its
 * own handler here, so validation follows the declared contract instead of
 * silently reinterpreting existing files with new matching semantics.
 */

import type { ConfigParseResult } from '../types.js';
import { isRecord } from './values.js';

export interface ConfigFormatHandler {
  readonly id: string;
  /** Legacy formats keep their documented behavior until a later issue converts them. */
  readonly legacy?: boolean;
  readonly parse: (raw: Record<string, unknown>) => ConfigParseResult;
}

export interface ConfigFormatIdentification {
  /** Declared or implicit format id; `null` only when the declaration is malformed. */
  readonly id: string | null;
  /** Whether the document declared `format` itself instead of inheriting it. */
  readonly explicit: boolean;
  readonly handler: ConfigFormatHandler | null;
  readonly error: string | null;
}

export const CONFIG_FORMAT_FIELD = 'format';

/** The format of a document that does not declare one: the current rule model. */
export const DEFAULT_CONFIG_FORMAT = 'arbiter-config-v1';

const handlers = new Map<string, ConfigFormatHandler>();

/**
 * Register one format parser. Returns a disposer so tests and future formats can
 * unregister without leaking a global parser into later cases.
 */
export function registerConfigFormat(handler: ConfigFormatHandler): () => void {
  if (handler.id.length === 0)
    throw new Error('configuration format id must not be empty');
  const existing = handlers.get(handler.id);
  if (existing !== undefined) {
    if (existing === handler) return () => undefined;
    throw new Error(
      `configuration format "${handler.id}" is already registered`,
    );
  }
  handlers.set(handler.id, handler);
  return () => {
    if (handlers.get(handler.id) === handler) handlers.delete(handler.id);
  };
}

export function registeredConfigFormats(): readonly string[] {
  return [...handlers.keys()];
}

/** Resolve the declared format, or the implicit current format, without parsing. */
export function identifyConfigFormat(raw: unknown): ConfigFormatIdentification {
  const declared = isRecord(raw) ? raw[CONFIG_FORMAT_FIELD] : undefined;
  const explicit = declared !== undefined;
  const id = declared === undefined ? DEFAULT_CONFIG_FORMAT : declared;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      id: null,
      explicit,
      handler: null,
      error: `"${CONFIG_FORMAT_FIELD}" must be a non-empty string`,
    };
  }
  const handler = handlers.get(id) ?? null;
  if (handler === null) {
    return {
      id,
      explicit,
      handler: null,
      error: `unknown configuration format "${id}"; supported: ${registeredConfigFormats().join(', ')}`,
    };
  }
  return { id, explicit, handler, error: null };
}
