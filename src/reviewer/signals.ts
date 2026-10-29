/**
 * Reading an answer back into the shared contract's two scores.
 *
 * Both protocols converge here: chat answers with two public integers, decision
 * with two native distributions. Neither adapter interprets the numbers — the
 * contract's readers do, and they are the same readers the engine and the evals
 * tooling use. This module only decides whether an answer is *well formed*, so an
 * unreadable answer is reported as such instead of being handed on as a score.
 *
 * Two distinctions are load-bearing:
 *
 *   - a format failure and a transport failure are different. A well-formed JSON
 *     object holding a bad band is a format failure that a chat repair can fix; a
 *     stream that never finished is a transport failure that no repair touches.
 *   - a refusal is not an answer. `success: false` decides on its own, even when
 *     the payload also carries complete answers, because a provider that reports
 *     failure is still forming its answer.
 */

import type {
  ChatScores,
  DecisionScores,
  ProtocolScores,
  ScoreFailure,
  ScoreTrail,
} from '../review-contract/types.js';
import {
  bandFromNative,
  chatScore,
  distributionToPublic,
} from '../review-contract/normalize.js';
import { decisionAnswers } from './envelope.js';
import { extractJsonObject } from './json.js';

/** The two answer members, in the order the prompt states them. */
const CHAT_MEMBERS = ['risk', 'authorization'] as const;

/** A well-formed answer, or the reason it is not one. */
export type ParsedAnswer =
  | {
      readonly ok: true;
      readonly scores: ProtocolScores;
      /** The provider's answer object, exactly as received. */
      readonly raw: unknown;
    }
  | {
      readonly ok: false;
      /** One sentence naming the violated rule, never the submitted text. */
      readonly error: string;
      /** Structured failures, when a field could be named. */
      readonly failures: readonly ScoreFailure[];
      /**
       * The half that did read, when only one field failed.
       *
       * This is diagnostic evidence and never a verdict: it lets a reader tell
       * "the reviewer was confused about one field" from "the transport broke",
       * which is exactly the distinction the shared outcome's `diagnostic` field
       * exists for. The trails are built by the contract's own readers, so a
       * partial read cannot disagree with a complete one about what a number means.
       */
      readonly partial: PartialTrails;
    };

/** A per-field partial read, in the shared outcome's own trail shape. */
export interface PartialTrails {
  readonly risk: ScoreTrail | null;
  readonly authorization: ScoreTrail | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * A chat answer: exactly two public integers.
 *
 * The member set is checked as well as the values. A model that adds a field is
 * not answering the question that was asked, and accepting the extra field would
 * let an arbitrary observation slip into a record whose shape the contract fixed.
 */
export function readChatAnswer(text: string): ParsedAnswer {
  let value: unknown;
  try {
    value = JSON.parse(extractJsonObject(text));
  } catch {
    // The library message quotes the input, which is model output and may echo
    // the material it was given; the fact of the failure is all a record needs.
    return {
      ok: false,
      error: 'reviewer output is not valid JSON',
      failures: [],
      partial: NO_PARTIAL,
    };
  }
  if (!isRecord(value)) {
    return {
      ok: false,
      error: 'reviewer output must be one JSON object',
      failures: [],
      partial: NO_PARTIAL,
    };
  }
  const keys = Object.keys(value).sort();
  if (
    keys.length !== CHAT_MEMBERS.length ||
    [...CHAT_MEMBERS].sort().some((key, index) => key !== keys[index])
  ) {
    return {
      ok: false,
      error: `reviewer output must contain exactly ${CHAT_MEMBERS.join(', ')}; received ${keys.join(', ') || '(none)'}`,
      failures: [],
      partial: NO_PARTIAL,
    };
  }
  const failures: ScoreFailure[] = [];
  const read = {
    risk: chatScore(value['risk']),
    authorization: chatScore(value['authorization']),
  };
  for (const field of CHAT_MEMBERS) {
    const attempt = read[field];
    if (attempt.ok) continue;
    failures.push({ field, reason: attempt.reason, detail: attempt.detail });
  }
  if (failures.length > 0 || !read.risk.ok || !read.authorization.ok) {
    return {
      ok: false,
      error: failures
        .map((failure) => `${failure.field} ${failure.detail}`)
        .join('; '),
      failures,
      // The field that read its band is kept as a trail; the failed half is null.
      partial: {
        risk: read.risk.ok ? pointTrail(read.risk.score) : null,
        authorization: read.authorization.ok
          ? pointTrail(read.authorization.score)
          : null,
      },
    };
  }
  const scores: ChatScores = {
    source: 'chat',
    risk: read.risk.score,
    authorization: read.authorization.score,
  };
  return { ok: true, scores, raw: value };
}

/**
 * A decision answer: two score answers, each carrying a probability object.
 *
 * The probabilities are passed on unvalidated on purpose. Their strict
 * validation — ten canonical native levels, finite non-negative values, a total
 * of one — lives in the contract's N0 reader, so a distribution that the contract
 * rejects is reported there with its own failure class instead of being rejected
 * twice under two sets of rules.
 */
export function readDecisionAnswer(parsedBody: unknown): ParsedAnswer {
  if (!isRecord(parsedBody)) {
    return {
      ok: false,
      error: 'decision response is not a JSON object',
      failures: [],
      partial: NO_PARTIAL,
    };
  }
  const answers = decisionAnswers(parsedBody);
  if (answers === undefined) {
    return {
      ok: false,
      error: 'decision response has no answers',
      failures: [],
      partial: NO_PARTIAL,
    };
  }
  // Both fields are read before either verdict is reported, so one bad answer
  // cannot hide whether the other one arrived — the valid half is exactly what a
  // reader needs to classify the failure.
  const risk = probabilitiesOf(answers, 'risk');
  const authorization = probabilitiesOf(answers, 'authorization');
  const problems = [risk, authorization].filter(
    (entry): entry is string => typeof entry === 'string',
  );
  if (
    problems.length > 0 ||
    typeof risk === 'string' ||
    typeof authorization === 'string'
  ) {
    return {
      ok: false,
      error: problems.join('; '),
      failures: [],
      partial: {
        risk: typeof risk === 'string' ? null : distributionTrail(risk, 'risk'),
        authorization:
          typeof authorization === 'string'
            ? null
            : distributionTrail(authorization, 'authorization'),
      },
    };
  }
  const scores: DecisionScores = {
    source: 'decision',
    risk,
    authorization,
  };
  return { ok: true, scores, raw: answers };
}

/** No field of this answer could be read at all. */
const NO_PARTIAL: PartialTrails = { risk: null, authorization: null };

/** A chat point as a trail. */
function pointTrail(score: number): ScoreTrail {
  const legal = chatScore(score);
  if (!legal.ok) {
    throw new RangeError(
      `a validated chat score cannot be illegal: ${legal.reason}`,
    );
  }
  return { native: null, published: null, point: score, score: legal.score };
}

/**
 * A native distribution as a trail.
 *
 * The band is derived by the contract, so an invalid distribution never reaches
 * here: the caller only builds a trail for a field whose probabilities parsed.
 */
function distributionTrail(
  native: Record<string, number>,
  rule: 'risk' | 'authorization',
): ScoreTrail {
  return {
    native,
    published: distributionToPublic(native),
    point: null,
    score: bandFromNative(native, rule),
  };
}

/** One answer's probability object, or why it is not one. */
function probabilitiesOf(
  answers: Record<string, unknown>,
  name: 'risk' | 'authorization',
): Record<string, number> | string {
  const answer = answers[name];
  if (!isRecord(answer)) return `missing ${name} answer`;
  const probabilities = answer['probabilities'];
  if (!isRecord(probabilities)) {
    return `${name} answer has no probability object`;
  }
  // Only numbers reach the contract reader; a string or null is a malformed
  // answer rather than a probability the reader should be asked to reject, so
  // it is refused here with a message that names the rule it broke.
  const counts: Record<string, number> = {};
  for (const [level, raw] of Object.entries(probabilities)) {
    if (typeof raw !== 'number') {
      return `${name} answer has a non-numeric probability`;
    }
    counts[level] = raw;
  }
  return counts;
}
