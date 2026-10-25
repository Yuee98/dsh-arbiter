import type {
  ArbiterConfig,
  ModelAttemptRecord,
  ReviewSignals,
  ReviewSnapshot,
} from '../types.js';
import type { LlmLike } from './chat.js';
import { runChatReviewer } from './chat.js';
import { runDecisionReviewer } from './decision.js';
import { renderRequest, renderUser } from './prompt.js';

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
  callId: 'reviewer-probe',
  sessionId: 'reviewer-probe',
  sessionKind: 'main',
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
      readonly signals: ReviewSignals;
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
  /** Same lookup-only seam the decision backend takes. */
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

function protocolOf(backend: 'chat' | 'decision'): string {
  return backend === 'chat' ? 'arbiter-chat-json-v1' : 'arbiter-decision-v1';
}

/** Replace every occurrence of a known secret, so no echo can carry it out. */
function redact(text: string, secrets: readonly string[]): string {
  return secrets.reduce(
    (current, secret) =>
      secret.length === 0 ? current : current.split(secret).join('[redacted]'),
    text,
  );
}

function redactUnknown(value: unknown, secrets: readonly string[]): unknown {
  if (secrets.length === 0) return value;
  if (typeof value === 'string') return redact(value, secrets);
  if (Array.isArray(value)) {
    const items: readonly unknown[] = value;
    return items.map((item) => redactUnknown(item, secrets));
  }
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        redactUnknown(item, secrets),
      ]),
    );
  }
  return value;
}

/**
 * The attempt as the page may see it.
 *
 * The adapter's own requests are already credential-free by construction, but a
 * provider is free to echo whatever it received in an error body or exception.
 * Known credential values are removed here — at the boundary that publishes the
 * material — because the alternative is trusting every provider's error text.
 */
function attemptOf(
  record: ModelAttemptRecord,
  secrets: readonly string[],
): ProbeAttempt {
  return {
    attempt: record.attempt,
    backend: record.backend,
    protocol: record.protocol,
    durationMs: record.durationMs,
    request: redactUnknown(record.request, secrets),
    responseText:
      record.responseText === null
        ? null
        : redact(record.responseText, secrets),
    parsed: redactUnknown(record.parsed, secrets),
    error: record.error === null ? null : redact(record.error, secrets),
  };
}

interface FailureEvidence {
  readonly attempts: readonly ProbeAttempt[];
  readonly error: string;
  readonly httpStatus: number | null;
}

/**
 * Identify the stage a failed probe stopped at.
 *
 * The adapter's shape carries the evidence: an attempt with no response text
 * never got an answer, one with an `HTTP <status>` error got a refusal, and one
 * with text but an error reached the parser. Credential resolution happens before
 * any attempt, which is why a named reference with no attempts is that case.
 */
function classify(evidence: FailureEvidence): ProbeFailure {
  const { attempts, error, httpStatus } = evidence;
  if (
    /credential .*is not configured|credential lookup failed|no api key|MISSING_CREDENTIAL/iu.test(
      error,
    )
  ) {
    return 'credential-missing';
  }
  if (httpStatus === 401 || httpStatus === 403) return 'unauthorized';
  if (httpStatus === 429) return 'rate-limited';
  if (httpStatus !== null && httpStatus >= 500) return 'unavailable';
  if (httpStatus !== null && httpStatus >= 400) return 'unavailable';
  if (/timed?\s?out|timeout/iu.test(error)) return 'timed-out';
  const transport = attempts.find(
    (entry) => entry.responseText === null && entry.error !== null,
  );
  if (transport !== undefined) {
    return /timed?\s?out|timeout/iu.test(transport.error ?? '')
      ? 'timed-out'
      : 'network';
  }
  if (attempts.some((entry) => entry.responseText !== null)) {
    // Text arrived but never satisfied the parser: a contract failure, and the
    // one case the format repair exists to fix.
    return 'invalid-output';
  }
  return attempts.length === 0 ? 'unknown' : 'unknown';
}

/** The HTTP status an attempt recorded, when the adapter rejected one. */
function httpStatusOf(attempts: readonly ProbeAttempt[]): number | null {
  for (const entry of attempts) {
    const match = /^HTTP (\d{3})$/u.exec(entry.error ?? '');
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
  const request = renderRequest(PROBE_SNAPSHOT);
  try {
    const result = await runChatReviewer(
      {
        llm,
        // No session: the probe names an explicit route, and a synthetic probe
        // must never borrow the caller's request header.
        chat: config.reviewer.chat,
        thresholds: config.policy.normal,
        signal,
      },
      PROBE_SNAPSHOT,
      request,
      PROBE_SNAPSHOT.callId,
    );
    const attempts = result.attempts.map((record) => attemptOf(record, []));
    if (result.ok) {
      // A cancel that raced the answer still wins: the user ended this run and
      // must not be shown a pass they cancelled.
      if (callerCancelled(signal)) {
        return failedResult(config, startedAt, 'cancelled', attempts);
      }
      return {
        status: 'passed',
        backend: 'chat',
        model: probeModel(config),
        protocol: attempts[0]?.protocol ?? protocolOf('chat'),
        durationMs: elapsed(startedAt),
        repairs: result.signals.repairs,
        signals: result.signals,
        attempts,
      };
    }
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal)
        ? 'cancelled'
        : classify({
            attempts,
            error: result.error,
            httpStatus: httpStatusOf(attempts),
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

async function runDecision(
  options: ProbeOptions,
  startedAt: number,
): Promise<ProbeResult> {
  const { config, credentials, fetch, signal } = options;
  const request = {
    user: renderUser(PROBE_SNAPSHOT),
    estimatedInputTokens: 0,
  };
  // Resolve the credential here as well, so the probe can name that stage and so
  // the resolved value can be redacted out of any provider echo. The adapter
  // resolves it again for the request itself; this is a boundary guard.
  let secret: string | undefined;
  if (config.reviewer.decision.apiKeyRef.length > 0) {
    try {
      secret = (await credentials?.resolve(config.reviewer.decision.apiKeyRef))
        ?.value;
    } catch {
      return failedResult(config, startedAt, 'credential-missing', []);
    }
    if (secret === undefined) {
      // The formal adapter would refuse this too; classifying it here names the
      // stage instead of reporting an empty, unexplained failure.
      return failedResult(config, startedAt, 'credential-missing', []);
    }
  }
  const secrets = secret === undefined ? [] : [secret];
  try {
    const result = await runDecisionReviewer(
      {
        fetch,
        credentials,
        decision: config.reviewer.decision,
        thresholds: config.policy.normal,
        signal,
      },
      PROBE_SNAPSHOT,
      request,
      PROBE_SNAPSHOT.callId,
    );
    const attempts = result.attempts.map((record) =>
      attemptOf(record, secrets),
    );
    if (result.ok) {
      if (callerCancelled(signal)) {
        return failedResult(config, startedAt, 'cancelled', attempts);
      }
      return {
        status: 'passed',
        backend: 'decision',
        model: probeModel(config),
        protocol: protocolOf('decision'),
        durationMs: elapsed(startedAt),
        // The decision protocol has no repair loop; it reports one attempt.
        repairs: 0,
        signals: result.signals,
        attempts,
      };
    }
    return failedResult(
      config,
      startedAt,
      callerCancelled(signal)
        ? 'cancelled'
        : classify({
            attempts,
            error: redact(result.error, secrets),
            httpStatus: httpStatusOf(attempts),
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
 * The probe calls the production adapters with their production parsers, so a
 * pass means "this backend answered in the contracted format" — never "the
 * action would be allowed". It reads nothing but the passed draft and never
 * writes configuration, audit rows, statistics, breaker state or approval
 * history. Each attempt keeps the adapter's own timeout; the probe adds no
 * outer deadline, because that would cut a legitimate format repair short.
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
