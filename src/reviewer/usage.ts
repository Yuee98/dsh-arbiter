/**
 * The shared token-usage contract.
 *
 * Production (the reviewer service and, after RQ-04, the audit records) and the
 * evals tooling read usage through this module and nowhere else, so the same
 * provider payload cannot be counted two ways. Three facts drive the shape:
 *
 *   - A provider reports what it reports. A field it never sent is *unknown*,
 *     never zero; a field it explicitly reported as zero stays zero. Those two
 *     are different facts and a report that prints `0` for both is lies.
 *   - Sub-counts overlap. Cached and reasoning tokens may already be inside the
 *     input or output count, or sit beside it, depending on the provider's own
 *     definition. This module never adds them into their parent, and it states
 *     the inclusion it can establish instead of guessing one.
 *   - One number is not a summary. A total that silently omits attempts whose
 *     usage was missing is not a total, so the aggregate reports the per-field
 *     coverage next to the sum.
 *
 * Nothing here reads the environment, the clock, the host or the network, and
 * nothing here scores anything: usage accounting is not part of a verdict.
 */

/**
 * The version of the field mapping below.
 *
 * A change to which provider field feeds which token bucket, or to a declared
 * inclusion, requires a new value: a stored record names the version it was
 * normalized under, so a reader can tell two mapping eras apart.
 */
export const USAGE_MAPPING_VERSION = 'review-usage-v1';

/** Which protocol reported the payload. */
export type UsageSource = 'chat' | 'decision';

/**
 * The six buckets every consumer reads.
 *
 * The names describe a meaning, not a provider field: `inputTokens` is whatever
 * this provider counts as input for this call, and the mapping table names where
 * that came from.
 */
export const USAGE_FIELDS = [
  'inputTokens',
  'outputTokens',
  'totalTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'reasoningTokens',
] as const;

export type UsageField = (typeof USAGE_FIELDS)[number];

/** One count, or `null` when this payload did not report it. */
export type TokenCounts = Readonly<Record<UsageField, number | null>>;

/**
 * How a sub-count relates to the count it belongs to.
 *
 * `contained` means the parent already includes it, so adding the two would
 * count it twice. `separate` means the provider reports it beside the parent.
 * `unknown` means this payload does not establish either, so a reader must not
 * sum it into a parent.
 */
export type UsageInclusion = 'contained' | 'separate' | 'unknown';

/** The inclusion of each sub-count, relative to its parent. */
export interface UsageInclusions {
  /** Cache reads relative to `inputTokens`. */
  readonly cacheRead: UsageInclusion;
  /** Cache writes relative to `inputTokens`. */
  readonly cacheWrite: UsageInclusion;
  /** Reasoning tokens relative to `outputTokens`. */
  readonly reasoning: UsageInclusion;
}

/** Where one bucket's number came from. */
export interface UsageFieldSource {
  readonly field: UsageField;
  /** Dotted path into the provider payload. */
  readonly path: string;
}

/**
 * One provider payload, normalized.
 *
 * `raw` is the payload as the adapter already masked it: this module never sees
 * an unmasked provider response, and it copies what it was given rather than
 * rebuilding it, so a stored record can always be re-read against the mapping.
 */
export interface UsageNormalized {
  readonly mappingVersion: string;
  readonly source: UsageSource;
  readonly tokens: TokenCounts;
  readonly inclusions: UsageInclusions;
  /** Which provider field fed which bucket, in mapping order. */
  readonly sources: readonly UsageFieldSource[];
  /**
   * Paths that were present but did not hold a usable count.
   *
   * Recorded rather than silently dropped: a provider that starts sending a
   * string, or a negative number, changes what the totals mean, and the reader
   * should see that this payload said something this contract could not use.
   */
  readonly ignored: readonly string[];
  readonly raw: unknown;
}

interface RelativeCount {
  readonly parent: 'inputTokens' | 'outputTokens';
  readonly inclusion: 'contained' | 'separate';
  readonly slot: keyof UsageInclusions;
}

interface MappingRule {
  readonly field: UsageField;
  /** Dotted path in the provider payload; the first matching rule wins. */
  readonly path: string;
  /** Set for a sub-count whose relationship to its parent this field name fixes. */
  readonly relative?: RelativeCount;
}

/**
 * The field mapping.
 *
 * The three vocabularies below are the ones this plugin actually receives: the
 * host's own chat stream (camelCase, adapter-normalized), the decision vendors'
 * snake_case payloads, and OpenAI's `prompt_tokens`/`completion_tokens` naming
 * that a compatible service may forward unchanged. Gemini's verbose names are
 * included because a compatible endpoint may proxy them.
 *
 * The inclusion declared per path is the provider's documented meaning for that
 * exact field name. It is attached to the path, not to the bucket, because two
 * providers spell cached reads differently and mean different things by them:
 * OpenAI's `*_details.cached_tokens` is part of the prompt total, while
 * Anthropic's `cache_read_input_tokens` is reported beside it.
 */
const MAPPING_RULES: readonly MappingRule[] = [
  { field: 'inputTokens', path: 'inputTokens' },
  { field: 'inputTokens', path: 'input_tokens' },
  { field: 'inputTokens', path: 'prompt_tokens' },
  { field: 'inputTokens', path: 'promptTokenCount' },
  { field: 'outputTokens', path: 'outputTokens' },
  { field: 'outputTokens', path: 'output_tokens' },
  { field: 'outputTokens', path: 'completion_tokens' },
  { field: 'outputTokens', path: 'candidatesTokenCount' },
  { field: 'totalTokens', path: 'totalTokens' },
  { field: 'totalTokens', path: 'total_tokens' },
  { field: 'totalTokens', path: 'totalTokenCount' },
  { field: 'cacheReadTokens', path: 'cacheReadTokens' },
  {
    field: 'cacheReadTokens',
    path: 'prompt_tokens_details.cached_tokens',
    relative: {
      parent: 'inputTokens',
      inclusion: 'contained',
      slot: 'cacheRead',
    },
  },
  {
    field: 'cacheReadTokens',
    path: 'input_tokens_details.cached_tokens',
    relative: {
      parent: 'inputTokens',
      inclusion: 'contained',
      slot: 'cacheRead',
    },
  },
  {
    field: 'cacheReadTokens',
    path: 'cachedContentTokenCount',
    relative: {
      parent: 'inputTokens',
      inclusion: 'contained',
      slot: 'cacheRead',
    },
  },
  {
    field: 'cacheReadTokens',
    path: 'cache_read_input_tokens',
    relative: {
      parent: 'inputTokens',
      inclusion: 'separate',
      slot: 'cacheRead',
    },
  },
  { field: 'cacheReadTokens', path: 'cache_read_tokens' },
  { field: 'cacheWriteTokens', path: 'cacheWriteTokens' },
  {
    field: 'cacheWriteTokens',
    path: 'input_tokens_details.cache_write_tokens',
    relative: {
      parent: 'inputTokens',
      inclusion: 'contained',
      slot: 'cacheWrite',
    },
  },
  {
    field: 'cacheWriteTokens',
    path: 'cache_creation_input_tokens',
    relative: {
      parent: 'inputTokens',
      inclusion: 'separate',
      slot: 'cacheWrite',
    },
  },
  { field: 'cacheWriteTokens', path: 'cache_write_tokens' },
  { field: 'reasoningTokens', path: 'reasoningTokens' },
  { field: 'reasoningTokens', path: 'reasoning_tokens' },
  {
    field: 'reasoningTokens',
    path: 'completion_tokens_details.reasoning_tokens',
    relative: {
      parent: 'outputTokens',
      inclusion: 'contained',
      slot: 'reasoning',
    },
  },
  {
    field: 'reasoningTokens',
    path: 'output_tokens_details.reasoning_tokens',
    relative: {
      parent: 'outputTokens',
      inclusion: 'contained',
      slot: 'reasoning',
    },
  },
  // Gemini counts thinking tokens outside `candidatesTokenCount`, so this one
  // relationship is established by the field names themselves rather than
  // inferred. A bare generic alias such as `reasoning_tokens` stays unknown: its
  // wording does not establish either relationship.
  {
    field: 'reasoningTokens',
    path: 'thoughtsTokenCount',
    relative: {
      parent: 'outputTokens',
      inclusion: 'separate',
      slot: 'reasoning',
    },
  },
];

const UNKNOWN_INCLUSIONS: UsageInclusions = {
  cacheRead: 'unknown',
  cacheWrite: 'unknown',
  reasoning: 'unknown',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Read a dotted path, or undefined when any step is absent or not an object. */
function readPath(value: unknown, path: string): unknown {
  let current: unknown = value;
  for (const key of path.split('.')) {
    if (!isRecord(current)) return undefined;
    current = current[key];
  }
  return current;
}

/**
 * A usable count, or null.
 *
 * Token counts are non-negative numbers. A string, a `null`, a negative number
 * and a non-finite value are not counts this contract can interpret, so the
 * field stays unknown and the path is reported as ignored.
 */
function countOf(value: unknown): number | null {
  if (typeof value !== 'number') return null;
  if (!Number.isFinite(value) || value < 0) return null;
  return value;
}

function emptyCounts(): Record<UsageField, number | null> {
  return {
    inputTokens: null,
    outputTokens: null,
    totalTokens: null,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: null,
  };
}

/**
 * Normalize one provider payload.
 *
 * `null` means nothing was reported at all, which is different from a payload
 * that was reported and held no usable count: the second returns a normalized
 * value with every bucket unknown, so a reader can see that the provider spoke
 * and said nothing this contract reads.
 */
export function normalizeUsage(
  source: UsageSource,
  raw: unknown,
): UsageNormalized | null {
  if (raw === null || raw === undefined) return null;
  const tokens = emptyCounts();
  const sources: UsageFieldSource[] = [];
  const ignored: string[] = [];
  const inclusions: Record<keyof UsageInclusions, UsageInclusion> = {
    ...UNKNOWN_INCLUSIONS,
  };
  for (const rule of MAPPING_RULES) {
    // First match wins: one bucket is fed once, even when a provider sends both
    // spellings of the same count. Choosing the first keeps the result stable
    // across payloads that carry a deprecated alias beside the current field.
    if (tokens[rule.field] !== null) continue;
    const found = readPath(raw, rule.path);
    if (found === undefined) continue;
    const count = countOf(found);
    if (count === null) {
      if (!ignored.includes(rule.path)) ignored.push(rule.path);
      continue;
    }
    tokens[rule.field] = count;
    sources.push({ field: rule.field, path: rule.path });
    if (rule.relative !== undefined) {
      inclusions[rule.relative.slot] = rule.relative.inclusion;
    }
  }
  return {
    mappingVersion: USAGE_MAPPING_VERSION,
    source,
    tokens,
    inclusions,
    sources,
    ignored,
    raw,
  };
}

/** One attempt's contribution to a review's usage summary. */
export interface UsageAttempt {
  /**
   * The identity of the actual model attempt.
   *
   * Aggregation dedupes on this value, so a reader that walks the same attempts
   * twice — a resumed run, a re-read record — cannot double-count them.
   */
  readonly attemptId: string;
  /** `null` when this attempt reported no usage at all. */
  readonly usage: UsageNormalized | null;
}

/** One bucket's sum plus how much of the attempt set it covers. */
export interface UsageFieldTotal {
  /** The sum of the reported values, or `null` when nothing was reported. */
  readonly total: number | null;
  /** Attempts that reported this bucket. */
  readonly reported: number;
  /** Attempts that did not report it. */
  readonly missing: number;
  /** Every attempt reported it, and at least one attempt exists. */
  readonly complete: boolean;
}

/**
 * A review's usage, over its actual attempts.
 *
 * `totals` never presents a partial sum as a whole: `total` is a sum over the
 * attempts that reported the field, and `missing` says how many did not. A
 * consumer that needs a strict total checks `complete`.
 */
export interface UsageAggregate {
  readonly mappingVersion: string;
  /** Distinct attempts considered, after identity dedupe. */
  readonly attempts: number;
  /** Attempts that carried a usage payload. */
  readonly withUsage: number;
  /** Entries dropped because their `attemptId` was already counted. */
  readonly duplicateAttempts: number;
  readonly totals: Readonly<Record<UsageField, UsageFieldTotal>>;
  readonly inclusions: UsageInclusions;
}

/**
 * Merge one sub-count's inclusion across the attempts that contributed to it.
 *
 * Only attempts that actually reported the sub-count matter: an attempt with no
 * cache-read value adds no tokens, so its silence says nothing about how the
 * summed value relates to its parent. Among the contributions, one unknown makes
 * the whole relationship unknown — a known-plus-unknown pair cannot be called
 * contained, because the unknown half might be reported beside the parent and the
 * report would then double-count it. Disagreement between two knowns is `unknown`
 * for the same reason.
 */
function mergeInclusion(
  contributions: readonly UsageInclusion[],
): UsageInclusion {
  if (contributions.length === 0) return 'unknown';
  const known = new Set(contributions.filter((value) => value !== 'unknown'));
  if (known.size !== 1) return 'unknown';
  // Any unknown among the contributors means the aggregate cannot claim one.
  return contributions.includes('unknown')
    ? 'unknown'
    : ([...known][0] ?? 'unknown');
}

/**
 * The inclusion each attempt reported for one sub-count, restricted to the
 * attempts that actually contributed a value to it.
 *
 * Filtering here is what keeps the merged relationship meaningful: a silent
 * attempt contributes no tokens, so classifying the sum by its silence would
 * claim a relationship for mass that is not part of the total.
 */
function contributions(
  counted: readonly UsageNormalized[],
  field: UsageField,
  slot: keyof UsageInclusions,
): UsageInclusion[] {
  return counted
    .filter((usage) => usage.tokens[field] !== null)
    .map((usage) => usage.inclusions[slot]);
}

/**
 * One bucket's sum and coverage across the attempts that reported usage.
 *
 * `total` is null rather than 0 when nothing reported the bucket: a zero would
 * read as "the provider said this call used no tokens", which is a different
 * fact from "the provider never said".
 */
function totalOf(
  counted: readonly UsageNormalized[],
  field: UsageField,
  attempts: number,
): UsageFieldTotal {
  let sum = 0;
  let reported = 0;
  for (const usage of counted) {
    const value = usage.tokens[field];
    if (value === null) continue;
    sum += value;
    reported += 1;
  }
  return {
    total: reported === 0 ? null : sum,
    reported,
    missing: attempts - reported,
    complete: reported > 0 && reported === attempts,
  };
}

/**
 * Summarize a review's usage by actual attempt.
 *
 * Entries are deduped by `attemptId`; the first occurrence wins, and the number
 * of dropped duplicates is reported rather than hidden.
 */
export function aggregateUsage(
  entries: readonly UsageAttempt[],
): UsageAggregate {
  const seen = new Set<string>();
  const counted: UsageNormalized[] = [];
  let duplicates = 0;
  for (const entry of entries) {
    if (seen.has(entry.attemptId)) {
      duplicates += 1;
      continue;
    }
    seen.add(entry.attemptId);
    if (entry.usage !== null) counted.push(entry.usage);
  }
  // One entry per bucket, listed explicitly rather than built by mapping over
  // `USAGE_FIELDS`: the literal is what proves every bucket is present, so a new
  // field cannot be added to the list and silently omitted from the summary.
  const total = (field: UsageField): UsageFieldTotal =>
    totalOf(counted, field, seen.size);
  const totals: Readonly<Record<UsageField, UsageFieldTotal>> = {
    inputTokens: total('inputTokens'),
    outputTokens: total('outputTokens'),
    totalTokens: total('totalTokens'),
    cacheReadTokens: total('cacheReadTokens'),
    cacheWriteTokens: total('cacheWriteTokens'),
    reasoningTokens: total('reasoningTokens'),
  };
  return {
    mappingVersion: USAGE_MAPPING_VERSION,
    attempts: seen.size,
    withUsage: counted.length,
    duplicateAttempts: duplicates,
    totals,
    inclusions: {
      cacheRead: mergeInclusion(
        contributions(counted, 'cacheReadTokens', 'cacheRead'),
      ),
      cacheWrite: mergeInclusion(
        contributions(counted, 'cacheWriteTokens', 'cacheWrite'),
      ),
      reasoning: mergeInclusion(
        contributions(counted, 'reasoningTokens', 'reasoning'),
      ),
    },
  };
}
