import type { ArbiterConfig, ReviewSnapshot } from '../types.js';
import type { ReviewOutcome } from '../review-contract/types.js';
import type { AttemptFailureKind, ReviewAttempt } from './attempt.js';
import { review, type DecisionBackend, type ChatBackend } from './service.js';
import type { LlmLike } from './llm.js';
import { CHAT_PROTOCOL, DECISION_PROTOCOL } from './contract.js';

/**
 * The fixed synthetic probe input.
 *
 * A connection test must not borrow the caller's history: no real session, no
 * tool call, no ask answer, no project files. This snapshot is built in code so
 * the request material is the same on every run and no live state is read. The
 * pending action is a harmless `printf`, which also keeps the sample small and
 * lets the model answer freely — the test checks the protocol, not permission.
 */
export const PROBE_SNAPSHOT: ReviewSnapshot = {
  version: 1,
  createdAt: 0,
  // The probe is not part of any call's decision chain; the revision is only
  // present so the snapshot shape stays one shape.
  configRevision: 'reviewer-probe',
  callId: 'reviewer-probe',
  sessionId: 'reviewer-probe',
  sessionKind: 'main',
  // The probe reads no session log, so it names no turn and synthesizes no gap.
  turn: null,
  tool: 'bash',
  cwd: '/tmp/arbiter-probe',
  action: {
    name: 'bash',
    arguments: { command: 'printf arbiter-probe' },
  },
  facts: null,
  projectRules: null,
  customRules: '',
  materials: [
    {
      id: 'project-rules',
      enabled: true,
      present: false,
      chars: 0,
      limit: 2_000,
      truncated: false,
    },
    {
      id: 'custom-rules',
      enabled: true,
      present: false,
      chars: 0,
      limit: 2_000,
      truncated: false,
    },
  ],
  evidence: [],
  evidenceTruncated: false,
  parentAuthorizationPresent: null,
  context: [],
  checkpoints: [],
  contextTruncated: false,
  priorVerdicts: [],
  historyTruncated: false,
  // A connection probe is a synthetic input: it belongs to no session, so it can
  // have no prior verdict and no source to read. Saying so is honest, and it keeps
  // the probe free of the caller's history by construction rather than by luck.
  historyStatus: {
    coverage: 'known-empty',
    windowTruncated: false,
    reason: null,
    sources: {
      memory: { read: 0, unavailable: null },
      session: { read: 0, unavailable: null },
      audit: { read: 0, unavailable: null },
    },
    reset: false,
  },
  // A probe is a synthetic input with no session behind it. It reports no
  // observation at all rather than borrowing a completeness claim that no
  // reader made.
  completeness: {
    status: 'complete',
    items: [],
    gaps: [],
    note: null,
  },
  missing: [],
  budget: {
    maxInputTokens: 10_000,
    estimatedInputTokens: 0,
    truncatedSegments: [],
  },
};

/**
 * Why a probe did not pass, as a stable code the page localizes.
 *
 * The design asks the test to say where it stopped — credential resolution,
 * authentication, model availability, quota, network, timeout, output contract —
 * so these are distinct codes rather than one generic failure. `unknown` is the
 * only honest answer when the evidence does not identify a stage; guessing a
 * cause would be worse than saying so.
 */
export type ProbeFailure =
  /** The draft follows the session, which names no testable model. */
  | 'model-required'
  /** The decision backend needs a credential reference that resolves. */
  | 'credential-missing'
  /** The endpoint rejected the credential (HTTP 401/403). */
  | 'unauthorized'
  /** The endpoint reported quota or rate limiting (HTTP 429). */
  | 'rate-limited'
  /** The provider is reachable but refused or is unavailable (5xx and similar). */
  | 'unavailable'
  /** The provider or endpoint could not be reached. */
  | 'network'
  /** The request outlived the adapter's own per-attempt timeout. */
  | 'timed-out'
  /** The answer arrived but never satisfied the formal parser. */
  | 'invalid-output'
  /** The user cancelled, or the host closed the connection. */
  | 'cancelled'
  /** The evidence does not identify a stage. */
  | 'unknown';

export interface ProbeAttempt {
  readonly attempt: number;
  readonly backend: 'chat' | 'decision';
  readonly protocol: string;
  readonly durationMs: number;
  /** Submitted material for this attempt, already free of credentials. */
  readonly request: unknown;
  readonly responseText: string | null;
  readonly parsed: unknown;
  readonly error: string | null;
}

export type ProbeResult =
  | {
      readonly status: 'passed';
      readonly backend: 'chat' | 'decision';
      /** The route actually used, resolved from the draft. */
      readonly model: ProbeModel;
      readonly protocol: string;
      readonly durationMs: number;
      /** Format repairs needed before the answer satisfied the parser. */
      readonly repairs: number;
      /**
       * The shared contract's outcome, not a verdict.
       *
       * A probe that passes has a scored review, because the probe's own material
       * is available by construction; an insufficient-material outcome would mean
       * the probe submitted something it should not, so it is reported rather
       * than hidden.
       */
      readonly outcome: ReviewOutcome;
      readonly attempts: readonly ProbeAttempt[];
    }
  | {
      readonly status: 'failed' | 'cancelled';
      readonly backend: 'chat' | 'decision';
      readonly model: ProbeModel;
      readonly protocol: string;
      readonly durationMs: number;
      readonly failure: ProbeFailure;
      readonly attempts: readonly ProbeAttempt[];
    };

/** The identity the dialog shows: what was asked, not what answered. */
export interface ProbeModel {
  readonly provider: string;
  readonly model: string;
}

export interface ProbeOptions {
  /** The policy section as it stands when the button is pressed. */
  readonly config: ArbiterConfig;
  readonly llm: LlmLike | undefined;
  /** Same lookup-only seam the decision transport takes. */
  readonly credentials:
    | {
        resolve(ref: string): Promise<{ readonly value: string } | undefined>;
      }
    | undefined;
  readonly fetch: typeof fetch;
  /** Caller lifetime: dialog cancel or a closed host connection. */
  readonly signal: AbortSignal;
}

function probeModel(config: ArbiterConfig): ProbeModel {
  return config.reviewer.type === 'chat'
    ? {
        provider: config.reviewer.chat.provider,
        model: config.reviewer.chat.model,
      }
    : {
        provider: 'decision',
        model: config.reviewer.decision.model,
      };
}

/**
 * Whether this run was ended by the caller.
 *
 * Only the caller's own signal answers this. An adapter-internal timeout can
 * surface as an `AbortError` too, so the error shape alone would report a real
 * timeout as a user cancellation; the caller's signal is the only evidence that
 * the user (or a dropped connection) is the cause.
 */
function callerCancelled(signal: AbortSignal): boolean {
  return signal.aborted;
}

function elapsed(startedAt: number): number {
  return Math.max(0, Date.now() - startedAt);
}

/**
 * The connection test's view of one attempt.
 *
 * The record arrives already masked: `review()` applies the masking boundary to
 * every attempt, including the credential the transport reported sending. Masking
 * it a second time here would be one more place the rule has to be right, so this
 * projection only selects and renames fields.
 */
function attemptOf(record: ReviewAttempt): ProbeAttempt {
  return {
    attempt: record.attempt,
    backend: record.backend,
    protocol: record.protocol,
    durationMs: record.durationMs,
    request: record.request,
    responseText: record.responseText,
    parsed: record.parsed,
    error: record.error,
  };
}

interface FailureEvidence {
  readonly attempts: readonly ProbeAttempt[];
  readonly error: string;
  readonly httpStatus: number | null;
  /** Why the last attempt failed, as the adapter recorded it. */
  readonly failureKind: AttemptFailureKind | null;
}

/** The stage an HTTP rejection names, or null when it names none. */
function httpFailure(httpStatus: number | null): ProbeFailure | null {
  if (httpStatus === 401 || httpStatus === 403) return 'unauthorized';
  if (httpStatus === 429) return 'rate-limited';
  if (httpStatus !== null && httpStatus >= 400) return 'unavailable';
  return null;
}

/**
 * The stage a provider failure code names.
 *
 * The formal chat adapter spells a provider failure as
 * `reviewer ended with <kind> <code>: <message>`. Well-known codes map to the
 * stage they describe; an unrecognized code stays `unknown` rather than being
 * called a network fault, because only the absence of an answer proves that.
 */
function providerFailure(error: string): ProbeFailure | null {
  const code = /reviewer ended with \S+ ([A-Z0-9_-]+):/u.exec(error)?.[1];
  if (code === undefined) return null;
  if (
    /AUTH|UNAUTHORI|FORBIDDEN|INVALID_API_KEY|INVALID_CREDENTIAL/iu.test(code)
  )
    return 'unauthorized';
  if (/RATE|QUOTA|TOO_MANY|LIMIT/iu.test(code)) return 'rate-limited';
  if (/TIMEOUT|TIMED_OUT/u.test(code)) return 'timed-out';
  // A provider-side cancel is the provider's own outcome. Only the caller's
  // signal may claim `cancelled`, so this stays an unnamed failure.
  return 'unknown';
}

/**
 * Identify the stage a failed probe stopped at.
 *
 * The adapter's shape carries the evidence: an attempt with no response text
 * never got an answer, one with an `HTTP <status>` error got a refusal, and one
 * with text but an error reached the parser. Credential resolution happens before
 * any attempt, which is why a named reference with no attempts is that case.
 * Everything unrecognized is `unknown`, never a guessed cause.
 */
function classify(evidence: FailureEvidence): ProbeFailure {
  const { attempts, error, httpStatus, failureKind } = evidence;
  if (
    /credential .*is not configured|credential lookup failed|no api key|MISSING_CREDENTIAL/iu.test(
      error,
    )
  ) {
    return 'credential-missing';
  }
  const byStatus = httpFailure(httpStatus);
  if (byStatus !== null) return byStatus;
  if (/timed?\s?out|timeout/iu.test(error)) return 'timed-out';
  const byProvider = providerFailure(error);
  if (byProvider !== null) return byProvider;
  const transport = attempts.find(
    (entry) => entry.responseText === null && entry.error !== null,
  );
  if (transport !== undefined) {
    return /timed?\s?out|timeout/iu.test(transport.error ?? '')
      ? 'timed-out'
      : 'network';
  }
  // The adapter's own record decides what arrived, rather than inferring it from
  // the text: an HTTP 200 with `success:false` carries a complete body, so a
  // "there was text" test would report a provider outage as a malformed answer.
  if (failureKind === 'provider-refusal') return 'unavailable';
  if (failureKind === 'unreadable-answer') {
    // Text arrived and never satisfied the parser: the one case the format
    // repair exists to fix.
    return 'invalid-output';
  }
  if (attempts.some((entry) => entry.responseText !== null)) {
    // No adapter verdict recorded it, but an answer did arrive; the parser is the
    // only thing that could have rejected it.
    return 'invalid-output';
  }
  return 'unknown';
}

/** The HTTP status an attempt recorded, when the adapter rejected one. */
function httpStatusOf(attempts: readonly ProbeAttempt[]): number | null {
  for (const entry of attempts) {
    // The adapter appends the provider's explanation after the status, so the
    // pattern matches a prefix rather than the whole string. Anchor on the
    // boundary so `HTTP 4010` cannot be read as 401.
    const match = /^HTTP (\d{3})(?:\b|$)/u.exec(entry.error ?? '');
    if (match !== null) return Number(match[1]);
  }
  return null;
}

function failedResult(
  config: ArbiterConfig,
  startedAt: number,
  failure: ProbeFailure,
  attempts: readonly ProbeAttempt[],
): ProbeResult {
  return {
    status: failure === 'cancelled' ? 'cancelled' : 'failed',
    backend: config.reviewer.type,
    model: probeModel(config),
    protocol: protocolOf(config.reviewer.type),
    durationMs: elapsed(startedAt),
    failure,
    attempts,
  };
}

/**
 * The protocol name of the draft's backend.
 *
 * The probe runs the production request, so this names the production contract
 * and not a probe-only variant: a pass through this value means the same request
 * a normal review would send satisfied the same parser.
 */
function protocolOf(backend: 'chat' | 'decision'): string {
  return backend === 'chat' ? CHAT_PROTOCOL : DECISION_PROTOCOL;
}

function passedResult(
  config: ArbiterConfig,
  startedAt: number,
  outcome: ReviewOutcome,
  repairs: number,
  attempts: readonly ProbeAttempt[],
): ProbeResult {
  return {
    status: 'passed',
    backend: config.reviewer.type,
    model: probeModel(config),
    protocol: attempts[0]?.protocol ?? protocolOf(config.reviewer.type),
    durationMs: elapsed(startedAt),
    repairs,
    outcome,
    attempts,
  };
}

async function runChat(
  options: ProbeOptions,
  startedAt: number,
): Promise<ProbeResult> {
  const { config, llm, signal } = options;
  if (config.reviewer.chat.provider === 'session') {
    // "Follow the session" names no model, so there is nothing to call; the
    // design disables the button instead of inventing a route.
    return failedResult(config, startedAt, 'model-required', []);
  }
  if (llm === undefined) {
    return failedResult(config, startedAt, 'unavailable', []);
  }
  const backend: ChatBackend = {
    kind: 'chat',
    transport: {
      llm,
      // No session: the probe names an explicit route, and a synthetic probe
      // must never borrow the caller's request header.
      chat: config.reviewer.chat,
      signal,
    },
  };
  try {
    const result = await review({
      snapshot: PROBE_SNAPSHOT,
      callId: PROBE_SNAPSHOT.callId,
      signal,
      backend,
    });
    const attempts = result.attempts.map((record) => attemptOf(record));
    if (result.outcome.status === 'scored') {
      // A cancel that raced the answer still wins: the user ended this run and
      // must not be shown a pass they cancelled.
      if (callerCancelled(signal)) {
        return failedResult(config, startedAt, 'cancelled', attempts);
      }
      return passedResult(
        config,
        startedAt,
        result.outcome,
        repairsOf(result.attempts),
        attempts,
      );
    }
    const error = outcomeError(result.outcome);
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal)
        ? 'cancelled'
        : classify({
            attempts,
            error,
            httpStatus: httpStatusOf(attempts),
            failureKind: lastFailureKind(result.attempts),
          }),
      attempts,
    );
  } catch {
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal) ? 'cancelled' : 'unknown',
      [],
    );
  }
}

/** The last attempt's recorded failure kind, which is what ended this run. */
function lastFailureKind(
  attempts: readonly ReviewAttempt[],
): AttemptFailureKind | null {
  return attempts.at(-1)?.failureKind ?? null;
}

/** How many attempts were format repairs: every attempt after the first that read. */
function repairsOf(attempts: readonly ReviewAttempt[]): number {
  return Math.max(0, attempts.length - 1);
}

/** The sentence an outcome's failure carries, for stage classification. */
function outcomeError(outcome: ReviewOutcome): string {
  return outcome.status === 'review-failure'
    ? outcome.reason
    : outcome.status === 'insufficient-material'
      ? outcome.reason
      : '';
}

/**
 * Resolve the decision credential once, naming the stage when it fails.
 *
 * The value is returned so the transport can send exactly it and the result can
 * redact exactly it. A caller cancellation during the lookup wins over a
 * credential verdict, because the user ended the run.
 */
async function decisionSecret(
  options: ProbeOptions,
): Promise<
  | { readonly kind: 'ok'; readonly secret: string | undefined }
  | { readonly kind: 'failed'; readonly failure: ProbeFailure }
> {
  const { config, credentials, signal } = options;
  if (config.reviewer.decision.apiKeyRef.length === 0)
    return { kind: 'ok', secret: undefined };
  let secret: string | undefined;
  try {
    secret = (await credentials?.resolve(config.reviewer.decision.apiKeyRef))
      ?.value;
  } catch {
    return {
      kind: 'failed',
      failure: callerCancelled(signal) ? 'cancelled' : 'credential-missing',
    };
  }
  if (callerCancelled(signal)) return { kind: 'failed', failure: 'cancelled' };
  if (secret === undefined)
    return { kind: 'failed', failure: 'credential-missing' };
  return { kind: 'ok', secret };
}

async function runDecision(
  options: ProbeOptions,
  startedAt: number,
): Promise<ProbeResult> {
  const { config, credentials, fetch, signal } = options;
  const resolved = await decisionSecret(options);
  if (resolved.kind === 'failed') {
    return failedResult(config, startedAt, resolved.failure, []);
  }
  const { secret } = resolved;
  const backend: DecisionBackend = {
    kind: 'decision',
    transport: {
      fetch,
      credentials,
      // The value resolved above is the one this run sends, which is also the one
      // the service masks out of every attempt it returns.
      ...(secret === undefined
        ? {}
        : { preResolvedCredential: { value: secret } }),
      decision: config.reviewer.decision,
      signal,
    },
  };
  try {
    const result = await review({
      snapshot: PROBE_SNAPSHOT,
      callId: PROBE_SNAPSHOT.callId,
      signal,
      backend,
    });
    const attempts = result.attempts.map((record) => attemptOf(record));
    if (result.outcome.status === 'scored') {
      if (callerCancelled(signal)) {
        return failedResult(config, startedAt, 'cancelled', attempts);
      }
      return passedResult(
        config,
        startedAt,
        result.outcome,
        // The decision protocol has no repair loop; it reports one attempt.
        0,
        attempts,
      );
    }
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal)
        ? 'cancelled'
        : classify({
            attempts,
            error: outcomeError(result.outcome),
            httpStatus: httpStatusOf(attempts),
            failureKind: lastFailureKind(result.attempts),
          }),
      attempts,
    );
  } catch {
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal) ? 'cancelled' : 'unknown',
      [],
    );
  }
}

/**
 * Run one Reviewer connection test.
 *
 * The probe calls the production reviewer service with its production renderer and
 * parser, so a pass means "this backend answered in the contracted format" —
 * never "the action would be allowed". It reads nothing but the passed draft and
 * never writes configuration, audit rows, statistics, breaker state or approval
 * history. Each attempt keeps the adapter's own timeout; the probe adds no outer
 * deadline, because that would cut a legitimate format repair short.
 */
export async function runReviewerProbe(
  options: ProbeOptions,
): Promise<ProbeResult> {
  const startedAt = Date.now();
  if (options.signal.aborted) {
    return failedResult(options.config, startedAt, 'cancelled', []);
  }
  return options.config.reviewer.type === 'chat'
    ? runChat(options, startedAt)
    : runDecision(options, startedAt);
}
