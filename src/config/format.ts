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
  readonly code?: string;
}

export const CONFIG_FORMAT_FIELD = 'format';

/** Format v2: scope, OR conditions and whole-value matching. */
export const CONFIG_FORMAT_V2 = 'arbiter-config-v2';

/**
 * The current rule format: v2 plus the rule-level `combine` connective.
 *
 * It is a separate declaration rather than a v2 field because a v2 document must
 * keep meaning "or": an older build reading a declared v2 file with `combine`
 * would ignore the field and evaluate the wider alternative.
 */
export const CONFIG_FORMAT_V3 = 'arbiter-config-v3';

/**
 * The legacy format, kept for documents that were written before v2.
 *
 * This is also the format of a document that does not declare one: identification
 * never guesses a newer meaning from the content, so an existing file keeps the
 * prefix semantics it was written for and is not silently reinterpreted as
 * whole-value matching.
 */
export const CONFIG_FORMAT_V1 = 'arbiter-config-v1';

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
  // An undeclared document keeps the legacy format rather than the newest one.
  const id = declared === undefined ? CONFIG_FORMAT_V1 : declared;
  if (typeof id !== 'string' || id.length === 0) {
    return {
      id: null,
      explicit,
      handler: null,
      error: `"${CONFIG_FORMAT_FIELD}" must be a non-empty string`,
      code: 'config.format-declaration',
    };
  }
  const handler = handlers.get(id) ?? null;
  if (handler === null) {
    return {
      id,
      explicit,
      handler: null,
      error: `unknown configuration format "${id}"; supported: ${registeredConfigFormats().join(', ')}`,
      code: 'config.format-unknown',
    };
  }
  return { id, explicit, handler, error: null };
}
