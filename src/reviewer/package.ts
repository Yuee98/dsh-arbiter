/**
 * The one seam that lets an experiment render a package without forking the service.
 *
 * `review()` has a single pipeline: render, send, read, score. Everything after the
 * read — the shared contract's N0, the outcome, the credential mask, the usage
 * aggregate — must be the same code for production and for every candidate, or two
 * candidates could differ for a reason that is not the experiment's variable.
 *
 * So the pipeline reads a *package*: how to render a request for a protocol, and how to
 * read that protocol's answer. Production's package is the production functions
 * themselves, so there is nothing here to keep in step with them. A variant package
 * renders a variant and delegates the *scores* to the same production reader: only
 * candidate B's chat answer needs a wrapper, because it carries one extra member and
 * the production reader is strict about the member set on purpose.
 *
 * The probe reading never enters the package's scores. It is collected beside them — the
 * chat wrapper returns it separately, and {@link probeOfAttempt} re-derives it from the
 * stored response — so no candidate can add an implicit gate by answering a question.
 */

import type { ReviewSnapshot } from '../types.js';
import type { ReviewAttempt } from './attempt.js';
import { decisionAnswers } from './envelope.js';
import { extractJsonObject } from './json.js';
import type { ChatRequest, DecisionRequest } from './prompt.js';
import {
  renderChatRequest,
  renderChatUser,
  renderDecisionRequest,
  renderVariantChatRequest,
  renderVariantDecisionRequest,
} from './prompt.js';
import type { ProbeReading } from './probe.js';
import { PROBE_MEMBER, readProbeAnswer } from './probe.js';
import type { ParsedAnswer } from './signals.js';
import { readChatAnswer, readDecisionAnswer } from './signals.js';
import { readVariantChatAnswer } from './variant-signals.js';
import type { ReviewVariant } from './variant.js';

/** Whether a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * How one package renders a request and reads the answer to it.
 *
 * `asksProbe` is stated by the package rather than inferred from an answer, because the
 * question asked and the answer accepted have to be the same one: a package that asked no
 * probe reads a third member as a malformed answer.
 */
export interface ReviewPackage {
  readonly renderChat: (snapshot: ReviewSnapshot) => ChatRequest;
  readonly renderDecision: (snapshot: ReviewSnapshot) => DecisionRequest;
  readonly readChat: (text: string) => ParsedAnswer;
  readonly readDecision: (body: unknown) => ParsedAnswer;
  readonly asksProbe: boolean;
}

/**
 * The probe readings one review's attempts carry, one per attempt.
 *
 * Derived from the stored attempts rather than carried through the service: the attempt's
 * `responseText` is the bytes the provider sent and its `parsed` is the answers object, so
 * a reader of a record can re-derive exactly what this returns. That is also why `review()`
 * needs no new field for it — a variant run and a stored record answer the same question
 * the same way.
 */
export function probesOf(
  pkg: ReviewPackage,
  attempts: readonly ReviewAttempt[],
): readonly ProbeReading[] {
  return attempts.map((attempt) =>
    probeOfAttempt({
      probeAsked: pkg.asksProbe,
      backend: attempt.backend,
      responseText: attempt.responseText,
      parsed: attempt.parsed,
    }),
  );
}

/**
 * The production package.
 *
 * Every member is the production function itself, so a change to production cannot
 * leave this baseline behind: there is nothing here to update.
 */
export const PRODUCTION_PACKAGE: ReviewPackage = {
  renderChat: renderChatRequest,
  renderDecision: (snapshot) => renderDecisionRequest(renderChatUser(snapshot)),
  readChat: readChatAnswer,
  readDecision: readDecisionAnswer,
  asksProbe: false,
};

/**
 * The package for one variant.
 *
 * The probe wrapper is installed only for candidate B. A package that asked no probe
 * must not accept a third member, because tolerating one would mean accepting an
 * answer production's reader would have rejected.
 */
export function variantPackage(variant: ReviewVariant): ReviewPackage {
  const probe = variant.prompt === 'recovery-probe';
  return {
    renderChat: (snapshot) => renderVariantChatRequest(snapshot, variant),
    renderDecision: (snapshot) =>
      renderVariantDecisionRequest(snapshot, variant),
    readChat: (text) =>
      probe ? readVariantChatAnswer(text).scored : readChatAnswer(text),
    readDecision: readDecisionAnswer,
    asksProbe: probe,
  };
}

/**
 * The probe reading one attempt's stored answer carries.
 *
 * Taken from what the transport actually kept rather than from a value passed along the
 * pipeline: the attempt's `responseText` is the bytes the provider sent, and the
 * decision attempt's `parsed` is the answers object the production envelope reader
 * located. Nothing is re-requested and nothing is re-scored.
 *
 * `not-asked` is returned for a package that asked no probe, and `unknown` for a
 * response that carried no readable answer — the two are different facts, and the
 * second one is a property of that attempt rather than of the candidate.
 */
export function probeOfAttempt(parts: {
  readonly probeAsked: boolean;
  readonly backend: 'chat' | 'decision';
  readonly responseText: string | null;
  readonly parsed: unknown;
}): ProbeReading {
  if (!parts.probeAsked) return { status: 'not-asked' };
  if (parts.backend === 'decision') {
    if (parts.parsed === null || parts.parsed === undefined) {
      return { status: 'unknown', reason: 'member-absent' };
    }
    if (!isRecord(parts.parsed)) {
      return { status: 'unknown', reason: 'not-a-string' };
    }
    return decisionProbeOf(decisionAnswers(parts.parsed));
  }
  if (parts.responseText === null) {
    return { status: 'unknown', reason: 'member-absent' };
  }
  return chatProbeOf(parts.responseText);
}

/**
 * The probe a chat response text carries.
 *
 * The text is parsed only to find the one member; the scores were read by the package's
 * own reader from the same bytes, so this cannot disagree with them about the object it
 * looked in. A body that is not a JSON object has no member to report, which is
 * `member-absent` rather than a guessed option.
 */
function chatProbeOf(text: string): ProbeReading {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return { status: 'unknown', reason: 'member-absent' };
  }
  if (!isRecord(parsed)) {
    return { status: 'unknown', reason: 'member-absent' };
  }
  return readProbeAnswer(parsed[PROBE_MEMBER]);
}

/** The probe a decision answers object carries. */
function decisionProbeOf(
  answers: Record<string, unknown> | undefined,
): ProbeReading {
  if (answers === undefined) {
    return { status: 'unknown', reason: 'member-absent' };
  }
  const answer = answers[PROBE_MEMBER];
  if (answer === undefined)
    return { status: 'unknown', reason: 'member-absent' };
  if (!isRecord(answer)) return { status: 'unknown', reason: 'not-a-string' };
  // A `choice` answer names its option; a model that filled a boolean or a score object
  // instead has not answered this question, which is reported as unreadable rather than
  // coerced into an option.
  return readProbeAnswer(answer['choice']);
}
