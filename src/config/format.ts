/**
 * The one configuration format this build reads.
 *
 * `arbiter-config-v3` is the current rule model: scope, a rule-level `combine`, any
 * number of `conditions`, typed JSONPath selection and whole-value matching.
 * Earlier formats are gone rather than migrated. A document that declares one is a
 * configuration error, and a rule still written in the retired single-condition
 * `match` shape is refused by name (see `rules.ts`), so no document is silently
 * reinterpreted under matching semantics it was not written for.
 *
 * A document that declares no format is read as this one. Absence describes the
 * writer's habit, not an older build: the retired prefix semantics no longer
 * exist, so there is nothing left for absence to select between.
 */

import { isRecord } from './values.js';

export const CONFIG_FORMAT_FIELD = 'format';

/** The only format id this build reads and writes. */
export const CONFIG_FORMAT_V3 = 'arbiter-config-v3';

/**
 * The retired declarations.
 *
 * They are a closed set so the refusal can name what replaced them: an operator
 * upgrading from one of these builds should learn that the format was removed,
 * not that their document has a typo.
 */
const RETIRED_CONFIG_FORMATS: ReadonlySet<unknown> = new Set([
  'arbiter-config-v1',
  'arbiter-config-v2',
]);

export interface ConfigFormatIdentification {
  /** Whether the document declared `format` itself instead of leaving it out. */
  readonly explicit: boolean;
  /** Why the declaration is unusable, or `null` when the document may be read. */
  readonly error: string | null;
  readonly code?: string;
  readonly params?: Readonly<Record<string, string>>;
}

/**
 * Judge the declaration without parsing anything else.
 *
 * An unusable declaration is reported before the rest of the document is read: a
 * file written for another format must not be judged by this one's rules first,
 * because those findings would bury the only actionable sentence.
 */
export function identifyConfigFormat(raw: unknown): ConfigFormatIdentification {
  const declared = isRecord(raw) ? raw[CONFIG_FORMAT_FIELD] : undefined;
  if (declared === undefined) return { explicit: false, error: null };
  if (typeof declared !== 'string' || declared.length === 0) {
    return {
      explicit: true,
      error: `"${CONFIG_FORMAT_FIELD}" must be a non-empty string`,
      code: 'config.format-declaration',
    };
  }
  if (RETIRED_CONFIG_FORMATS.has(declared)) {
    return {
      explicit: true,
      error: `configuration format "${declared}" was retired; this build reads only "${CONFIG_FORMAT_V3}" and does not convert old rules`,
      code: 'config.format-retired',
      params: { format: declared, current: CONFIG_FORMAT_V3 },
    };
  }
  if (declared !== CONFIG_FORMAT_V3) {
    return {
      explicit: true,
      error: `unknown configuration format "${declared}"; supported: ${CONFIG_FORMAT_V3}`,
      code: 'config.format-unknown',
    };
  }
  return { explicit: true, error: null };
}
