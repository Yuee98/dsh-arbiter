/**
 * The replay's three axes, and how a caller states them.
 *
 * A variant is a *rule*, not a run. It says which stored copy of an answer to
 * re-read, which comparison selects a band, and which settlement settings the
 * derived report should use. Nothing about a variant can cause a request, so a
 * variant document is a small, reviewable description of an experiment on
 * evidence that already exists.
 *
 * Two properties make variants comparable rather than merely configurable:
 *
 *   - every axis has a declared default, and the defaults are production's own.
 *     A variant that names nothing therefore replays the run as it was decided,
 *     which is what makes "the same version reproduces the original result" a
 *     check rather than a hope.
 *   - a variant's identity is the digest of its axes, excluding the description.
 *     Two derivations that differ in any axis cannot share an output directory,
 *     and renaming a variant cannot fork its results.
 *
 * Parsing refuses rather than repairs. An unknown axis value, a duplicated
 * variant or a document from another format era is a mistake in the document
 * being read, and quietly falling back to a default would produce a derivation
 * nobody asked for under a name that claims they did.
 */

import type { AskPolicy } from '../../../src/review-contract/matrix.js';

import { digestOf } from '../data/hash.js';
import type {
  AnswerCandidate,
  ThresholdRule,
  ThresholdRules,
  ReplayVariant,
  SettlementChoice,
} from './types.js';
import { PRODUCTION_THRESHOLDS, REPLAY_VARIANTS_VERSION } from './types.js';

/** The answer candidates, in the order a document may name them. */
const ANSWER_CANDIDATES: readonly AnswerCandidate[] = [
  'response-text',
  'recorded-parse',
];

/** The two comparisons a threshold may name. */
const THRESHOLD_RULES: readonly ThresholdRule[] = ['strict', 'at-least'];

/**
 * The member names each layer accepts, and nothing else.
 *
 * A misspelled axis is the most likely mistake a person makes in a variants file, and
 * it is the one a lenient reader handles worst: dropping the member leaves the axis at
 * its production default, so `{"thresholds":{"auth":"at-least"}}` produces exactly the
 * derivation the production variant produces, published under a name that claims the
 * caller asked for an experiment. Nothing downstream can tell that apart from a
 * deliberate replay of the default, so the document has to be refused here.
 *
 * These lists are the single place the accepted names are stated; `statedVariantOf`,
 * `thresholdPairOf` and `settlementOfStated` each check their own list before reading
 * a member, so a name cannot be accepted by one layer and forgotten by another.
 */
const VARIANT_MEMBERS: readonly string[] = [
  'description',
  'answer',
  'thresholds',
  'settlement',
];
const THRESHOLD_MEMBERS: readonly string[] = ['risk', 'authorization'];
const SETTLEMENT_MEMBERS: readonly string[] = ['mode', 'channel'];
/** The document's own members, checked once rather than per variant. */
const DOCUMENT_MEMBERS: readonly string[] = [
  'variantsVersion',
  'description',
  'variants',
];

/**
 * The members of `value` that `allowed` does not name, in the order they appear.
 *
 * Sorted so the message is stable: two people reporting the same typo should be able
 * to diff their output.
 */
function unknownMembers(
  value: Record<string, unknown>,
  allowed: readonly string[],
): readonly string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .sort();
}

/**
 * The problem an unknown member causes, or null when every member is known.
 *
 * The message names the accepted spellings, because the mistake is almost always one
 * of them and a list turns a silent fallback into a one-line fix.
 */
function unknownMemberProblem(parts: {
  readonly layer: string;
  readonly value: Record<string, unknown>;
  readonly allowed: readonly string[];
}): string | null {
  const unknown = unknownMembers(parts.value, parts.allowed);
  if (unknown.length === 0) return null;
  return `${parts.layer} does not take ${unknown.join(', ')}; it accepts ${parts.allowed.join(', ')}`;
}

/** The two ask policies and the two channel states a settlement may name. */
const ASK_POLICIES: readonly AskPolicy[] = ['ask', 'no-ask'];
const CHANNELS: readonly SettlementChoice['channel'][] = [
  'available',
  'unavailable',
];

/**
 * The settlement settings a variant uses when it names none.
 *
 * They are the report's own defaults (`defaultSettings` in `evals/src/metrics`):
 * ask, with a reachable channel. A replay inherits them so that a variant which
 * only varies N0 does not silently also change layer three.
 */
const DEFAULT_SETTLEMENT: SettlementChoice = {
  mode: 'ask',
  channel: 'available',
};

/**
 * The stored answer a variant reads when it names none.
 *
 * The recorded response body is the issue's subject: it is the copy that survives
 * a change to the mapping version, the parser or the prompt's answer shape. The
 * adapter's parse is the fallback a caller reaches for when masking has left the
 * text unreadable, and having to ask for it keeps that limitation visible.
 */
const DEFAULT_ANSWER: AnswerCandidate = 'response-text';

/** One variant as a caller states it, with every axis optional. */
export interface StatedVariant {
  readonly description?: string;
  readonly answer?: string;
  readonly thresholds?: {
    readonly risk?: string;
    readonly authorization?: string;
  };
  readonly settlement?: {
    readonly mode?: string;
    readonly channel?: string;
  };
}

/** A parsed variants document. */
export interface VariantsDocument {
  readonly variantsVersion: typeof REPLAY_VARIANTS_VERSION;
  readonly description?: string;
  readonly variants: readonly StatedVariant[];
}

/** A parse that produced variants, or why it produced none. */
export type VariantsParse =
  | {
      readonly ok: true;
      readonly variants: readonly ReplayVariant[];
      readonly documentVersion: string | null;
    }
  | { readonly ok: false; readonly problems: readonly string[] };

/**
 * Whether a value is one of a closed set, returning it rather than a cast.
 *
 * The axes are protocol values, so a wrong spelling is a mistake in the document
 * and not something to normalise: `at least` and `at-least` would otherwise name
 * two different rules that compare identically.
 */
function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return allowed.find((candidate) => candidate === value) ?? null;
}

/** A variant's axis digest, which is what its identity is. */
export function variantDigest(axes: {
  readonly answer: AnswerCandidate;
  readonly thresholds: ThresholdRules;
  readonly settlement: SettlementChoice;
}): string {
  return digestOf({
    answer: axes.answer,
    thresholds: axes.thresholds,
    settlement: axes.settlement,
  });
}

/**
 * The label a variant's identity is readable as.
 *
 * The digest is truncated only because it appears in a directory name; the
 * lineage carries the full axes, so the short form is never the only record of
 * what a variant was.
 */
function labelOf(axes: {
  readonly answer: AnswerCandidate;
  readonly thresholds: ThresholdRules;
  readonly settlement: SettlementChoice;
}): string {
  const answer = axes.answer === 'response-text' ? 'text' : 'parsed';
  // The label is a filesystem name: only lowercase letters, digits and hyphens,
  // because it becomes part of the derived run's id and that id is a slug.
  return [
    answer,
    axes.thresholds.risk,
    axes.thresholds.authorization,
    axes.settlement.mode,
    axes.settlement.channel,
  ].join('-');
}

/** One fully resolved variant, from its stated axes and a description. */
export function resolveVariant(stated: StatedVariant): ReplayVariant | string {
  const answer =
    stated.answer === undefined
      ? DEFAULT_ANSWER
      : oneOf(stated.answer, ANSWER_CANDIDATES);
  if (answer === null) {
    return `answer must be one of ${ANSWER_CANDIDATES.join(', ')}, not ${String(stated.answer)}`;
  }
  const risk =
    stated.thresholds?.risk === undefined
      ? PRODUCTION_THRESHOLDS.risk
      : oneOf(stated.thresholds.risk, THRESHOLD_RULES);
  if (risk === null) {
    return `thresholds.risk must be one of ${THRESHOLD_RULES.join(', ')}, not ${String(stated.thresholds?.risk)}`;
  }
  const authorization =
    stated.thresholds?.authorization === undefined
      ? PRODUCTION_THRESHOLDS.authorization
      : oneOf(stated.thresholds.authorization, THRESHOLD_RULES);
  if (authorization === null) {
    return `thresholds.authorization must be one of ${THRESHOLD_RULES.join(', ')}, not ${String(stated.thresholds?.authorization)}`;
  }
  const mode =
    stated.settlement?.mode === undefined
      ? DEFAULT_SETTLEMENT.mode
      : oneOf(stated.settlement.mode, ASK_POLICIES);
  if (mode === null) {
    return `settlement.mode must be one of ${ASK_POLICIES.join(', ')}, not ${String(stated.settlement?.mode)}`;
  }
  const channel =
    stated.settlement?.channel === undefined
      ? DEFAULT_SETTLEMENT.channel
      : oneOf(stated.settlement.channel, CHANNELS);
  if (channel === null) {
    return `settlement.channel must be one of ${CHANNELS.join(', ')}, not ${String(stated.settlement?.channel)}`;
  }
  const axes = {
    answer,
    thresholds: { risk, authorization },
    settlement: { mode, channel },
  } as const;
  const description = stated.description ?? labelOf(axes);
  if (description.trim().length === 0) {
    return 'description must not be blank';
  }
  return {
    ...axes,
    variantId: labelOf(axes),
    digest: variantDigest(axes),
    description,
  };
}

/**
 * Read a variants document.
 *
 * The document version is checked because the axes it names decide what a
 * derivation means: reading an older or newer spelling as today's would attach
 * today's semantics to a description written under other ones. A caller that
 * states variants through flags has no document, which is why the version is
 * returned rather than required by `ReplayVariant`.
 *
 * Two variants with the same axes are refused instead of deduplicated: folding
 * them would discard one of the descriptions the caller wrote, and that
 * description is the only thing distinguishing two otherwise identical requests.
 */
export function parseVariants(document: unknown): VariantsParse {
  if (document === null || typeof document !== 'object') {
    return { ok: false, problems: ['the variants document is not an object'] };
  }
  // `typeof` already excluded every non-object, so this narrowing needs no cast: a
  // document that is an array is not a variants document either, which the member check
  // reports as the unknown keys of an array.
  const unknown = unknownMemberProblem({
    layer: 'a variants document',
    value: isRecord(document) ? document : { 'not-an-object': true },
    allowed: DOCUMENT_MEMBERS,
  });
  if (unknown !== null) return { ok: false, problems: [unknown] };
  const version = fieldOf(document, 'variantsVersion');
  if (version !== REPLAY_VARIANTS_VERSION) {
    return {
      ok: false,
      problems: [
        `the variants document declares ${String(version)}, this build reads ${REPLAY_VARIANTS_VERSION}`,
      ],
    };
  }
  const stated = fieldOf(document, 'variants');
  if (!Array.isArray(stated)) {
    return {
      ok: false,
      problems: ['the variants document holds no variant list'],
    };
  }
  if (stated.length === 0) {
    return { ok: false, problems: ['the variants document names no variants'] };
  }
  const problems: string[] = [];
  const variants: ReplayVariant[] = [];
  const seen = new Map<string, string>();
  for (const [index, entry] of stated.entries()) {
    const parsedEntry = statedVariantOf(entry);
    if ('problem' in parsedEntry) {
      problems.push(`variants[${String(index)}] ${parsedEntry.problem}`);
      continue;
    }
    const resolved = resolveVariant(parsedEntry.stated);
    if (typeof resolved === 'string') {
      problems.push(`variants[${String(index)}]: ${resolved}`);
      continue;
    }
    const previous = seen.get(resolved.digest);
    if (previous !== undefined) {
      problems.push(
        `variants[${String(index)}] repeats the axes of "${previous}" (${resolved.variantId}); one derivation cannot carry two descriptions`,
      );
      continue;
    }
    seen.set(resolved.digest, resolved.description);
    variants.push(resolved);
  }
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    variants,
    documentVersion: REPLAY_VARIANTS_VERSION,
  };
}

/** The variant a caller states entirely through flags. */
export interface FlagsVariant {
  readonly answer: string | null;
  readonly thresholdRisk: string | null;
  readonly thresholdAuthorization: string | null;
  readonly mode: string | null;
  readonly channel: string | null;
}

/** Resolve the one variant a flag-only caller stated. */
export function variantFromFlags(flags: FlagsVariant): ReplayVariant | string {
  return resolveVariant({
    description:
      'a variant stated on the command line: every axis it did not name keeps its production default',
    ...(flags.answer === null ? {} : { answer: flags.answer }),
    thresholds: {
      ...(flags.thresholdRisk === null ? {} : { risk: flags.thresholdRisk }),
      ...(flags.thresholdAuthorization === null
        ? {}
        : { authorization: flags.thresholdAuthorization }),
    },
    settlement: {
      ...(flags.mode === null ? {} : { mode: flags.mode }),
      ...(flags.channel === null ? {} : { channel: flags.channel }),
    },
  });
}

/**
 * One member of the incoming document, read without narrowing the whole value.
 *
 * The document is untrusted JSON, so every read is guarded rather than cast: a
 * variants file is something a person writes, and a member of the wrong type has to
 * be reported as that mistake instead of reaching a field access.
 */
function fieldOf(document: object, name: string): unknown {
  return Reflect.get(document, name);
}

/**
 * One entry as the axis reader's own shape.
 *
 * A member of the wrong type is reported rather than dropped. Dropping it would let
 * `"answer": 5` fall back to the default candidate and produce a derivation under a
 * name that says nothing about the mistake, which is the one thing a replay must not
 * do: the whole output is the claim "this rule produced these numbers".
 */
function statedVariantOf(
  entry: unknown,
): { readonly stated: StatedVariant } | { readonly problem: string } {
  if (!isRecord(entry)) return { problem: 'is not an object' };
  const unknown = unknownMemberProblem({
    layer: 'a variant',
    value: entry,
    allowed: VARIANT_MEMBERS,
  });
  if (unknown !== null) return { problem: unknown };
  const description = fieldOf(entry, 'description');
  if (description !== undefined && typeof description !== 'string') {
    return { problem: 'description must be a string' };
  }
  const answer = optionalString(entry, 'answer');
  if (typeof answer !== 'string' && answer !== null) return answer;
  const thresholds = thresholdPairOf(fieldOf(entry, 'thresholds'));
  if ('problem' in thresholds) return thresholds;
  const settlement = settlementOfStated(fieldOf(entry, 'settlement'));
  if ('problem' in settlement) return settlement;
  return {
    stated: {
      ...(description === undefined ? {} : { description }),
      ...(answer === null ? {} : { answer }),
      ...(thresholds.value === null ? {} : { thresholds: thresholds.value }),
      ...(settlement.value === null ? {} : { settlement: settlement.value }),
    },
  };
}

/**
 * One optional string member.
 *
 * `null` means the member is absent; a string is the value; anything else is the
 * problem, which is why the union has three states instead of a nullable string.
 */
function optionalString(
  entry: Record<string, unknown>,
  name: string,
): string | null | { readonly problem: string } {
  const value = fieldOf(entry, name);
  if (value === undefined) return null;
  if (typeof value !== 'string') return { problem: `${name} must be a string` };
  return value;
}

/** The two threshold spells, or the problem one of them has. */
function thresholdPairOf(value: unknown):
  | {
      readonly value: {
        readonly risk?: string;
        readonly authorization?: string;
      } | null;
    }
  | { readonly problem: string } {
  if (value === undefined) return { value: null };
  if (!isRecord(value)) return { problem: 'thresholds must be an object' };
  const unknown = unknownMemberProblem({
    layer: 'thresholds',
    value,
    allowed: THRESHOLD_MEMBERS,
  });
  if (unknown !== null) return { problem: unknown };
  const risk = optionalString(value, 'risk');
  if (typeof risk !== 'string' && risk !== null) return risk;
  const authorization = optionalString(value, 'authorization');
  if (typeof authorization !== 'string' && authorization !== null) {
    return authorization;
  }
  return {
    value: {
      ...(risk === null ? {} : { risk }),
      ...(authorization === null ? {} : { authorization }),
    },
  };
}

/** The settlement pair, or the problem one of its members has. */
function settlementOfStated(value: unknown):
  | {
      readonly value: {
        readonly mode?: string;
        readonly channel?: string;
      } | null;
    }
  | { readonly problem: string } {
  if (value === undefined) return { value: null };
  if (!isRecord(value)) return { problem: 'settlement must be an object' };
  const unknown = unknownMemberProblem({
    layer: 'settlement',
    value,
    allowed: SETTLEMENT_MEMBERS,
  });
  if (unknown !== null) return { problem: unknown };
  const mode = optionalString(value, 'mode');
  if (typeof mode !== 'string' && mode !== null) return mode;
  const channel = optionalString(value, 'channel');
  if (typeof channel !== 'string' && channel !== null) return channel;
  return {
    value: {
      ...(mode === null ? {} : { mode }),
      ...(channel === null ? {} : { channel }),
    },
  };
}

/** A plain object, for narrowing without a cast. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Whether a stated variant asks for anything the flags also name. */
export function statesAnyAxis(flags: FlagsVariant): boolean {
  return (
    flags.answer !== null ||
    flags.thresholdRisk !== null ||
    flags.thresholdAuthorization !== null ||
    flags.mode !== null ||
    flags.channel !== null
  );
}
