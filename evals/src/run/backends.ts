/**
 * Constructing the production backends a run drives.
 *
 * Every cell is one `review()` call from `src/reviewer/service.ts` — the same call
 * production makes. This module only decides *which socket* that call uses, and it
 * offers exactly the two the reviewer's own offline adapters publish:
 *
 *   offline  the production offline adapter, scripted from the run's fixture. The
 *            renderer, envelope rule, parser, normalization and outcome mapping all
 *            still run; only the socket is replaced.
 *   live     the same production transports against a real provider. Nothing here
 *            reaches the network for an offline plan, and nothing constructs a live
 *            backend unless the plan asked for one.
 *
 * The decision credential is read from the environment at call time and handed to
 * the transport as a value it already holds, which is the only place that knows what
 * it sent and therefore the only place that can mask it. This module never stores
 * it, never puts it in a record, and never copies it into a document.
 *
 * The caller's signal is stamped on every transport here rather than defaulted, so
 * an aborted run reaches the in-flight request. A backend built with a placeholder
 * signal would keep working after the run cancelled, which is exactly the behaviour
 * a cancellation test is supposed to rule out.
 */

import type {
  ChatBackend,
  DecisionBackend,
} from '../../../src/reviewer/service.js';
import {
  offlineChatBackend,
  offlineDecisionBackend,
} from '../../../src/reviewer/offline.js';
import { estimateTokenCount } from 'tokenx';

import type { LlmLike } from '../../../src/reviewer/llm.js';

import { credentialRefOf } from './plan.js';
import type {
  FixtureCell,
  FixtureResponse,
  RunProtocol,
  RunTarget,
  RunTransportName,
} from './types.js';

/** What a backend needs beyond its own configuration. */
export interface BackendContext {
  readonly transport: RunTransportName;
  /** The fixture's scripts for this cell; null for a live plan. */
  readonly fixture: FixtureCell | null;
  /** The run's input bound, which every chat attempt must respect. */
  readonly maxInputTokens: number;
  /** The caller's lifetime, so an aborted run stops its in-flight request. */
  readonly signal: AbortSignal;
  /** How a live chat call reaches the host's LLM service. */
  readonly llm: LlmLike | null;
  /** Reads one environment variable, so a test never needs a real credential. */
  readonly readCredential: (name: string) => string | undefined;
}

/** A backend, or why this cell's transport could not be built. */
export type BackendResult =
  | { readonly ok: true; readonly backend: ChatBackend | DecisionBackend }
  | { readonly ok: false; readonly message: string };

/**
 * The offline chat backend for one cell.
 *
 * The scripted answers are handed over exactly as the fixture wrote them, because
 * the production offline adapter is what interprets them: a second reader here
 * would be a second definition of what a scripted refusal means.
 */
function offlineChat(
  target: RunTarget,
  fixture: FixtureCell,
  maxInputTokens: number,
): BackendResult {
  const config = target.chat;
  if (config === null) {
    return {
      ok: false,
      message: `target ${target.targetId} has no chat config`,
    };
  }
  const scripts = fixture.chat;
  if (scripts === null || scripts.length === 0) {
    // Replaying nothing is not the same as replaying a refusal. The production
    // adapter would throw on the first read; saying it here names the cell instead
    // of surfacing an exhausted-script error with no context.
    return {
      ok: false,
      message: `fixture scripts no chat answer for target ${target.targetId}`,
    };
  }
  const replay = offlineChatBackend({
    scripts,
    provider: config.provider,
    model: config.model,
  });
  // The bound applies to the offline replay too: a fixture drives the same production
  // transport, so a repair it provokes must be measured the same way. Guarding only the live
  // path would let a test fixture send more than a live run ever could.
  return {
    ok: true,
    backend: {
      ...replay,
      transport: {
        ...replay.transport,
        llm: boundedStream({
          llm: replay.transport.llm,
          maxInputTokens: maxInputTokens,
          provider: config.provider,
          model: config.model,
        }),
      },
    },
  };
}

/** The offline decision backend for one cell, keyed by the cell's own responses. */
function offlineDecision(
  target: RunTarget,
  fixture: FixtureCell,
): BackendResult {
  const config = target.decision;
  if (config === null) {
    return {
      ok: false,
      message: `target ${target.targetId} has no decision config`,
    };
  }
  const responses = fixture.decision;
  if (responses === null || responses.length === 0) {
    return {
      ok: false,
      message: `fixture scripts no decision response for target ${target.targetId}`,
    };
  }
  return {
    ok: true,
    backend: offlineDecisionBackend({
      scripts: responses.map((response: FixtureResponse) => response),
      url: config.url,
      model: config.model,
    }),
  };
}

/**
 * A chat stream guard that enforces the run's input bound on every attempt.
 *
 * Admission can only measure the request it is about to build — the first one. A repair is
 * built later, inside production's transport, and its size depends on the rejection text
 * production embeds: `readChatAnswer` reports every unexpected key it found, and a key has
 * no length limit, so a malformed answer with one very long unexpected member produces a
 * correction message far larger than any constant allowance.
 *
 * The guard therefore measures the messages of *each* call with the same estimator the
 * renderer uses, and refuses the oversized one before it is sent. A refusal is an error the
 * transport reports as a failed attempt, which is exactly right: the request was never made,
 * so the artifact must not record it as an attempt that reached a provider.
 */
function boundedStream(parts: {
  readonly llm: LlmLike;
  readonly maxInputTokens: number;
  readonly provider: string;
  readonly model: string;
}): LlmLike {
  return {
    stream: (options) => {
      const tokens =
        estimateTokenCount(options.system) +
        options.messages.reduce(
          (sum, message) =>
            sum +
            message.content.reduce(
              (inner, part) => inner + estimateTokenCount(part.text),
              0,
            ),
          0,
        );
      if (tokens > parts.maxInputTokens) {
        throw new RangeError(
          `refusing to send ${String(tokens)} input tokens from ${parts.provider}/${parts.model}: above the run's ${String(parts.maxInputTokens)} bound`,
        );
      }
      return parts.llm.stream(options);
    },
  };
}

/**
 * The live chat backend for one cell.
 *
 * `provider: "session"` is refused rather than resolved: there is no host session in
 * a headless run, and the production route resolver would fail on it after the plan
 * was already accepted. Refusing here names the plan's mistake at the place it can
 * still be fixed.
 */
function liveChat(
  target: RunTarget,
  llm: LlmLike | null,
  maxInputTokens: number,
): BackendResult {
  const config = target.chat;
  if (config === null) {
    return {
      ok: false,
      message: `target ${target.targetId} has no chat config`,
    };
  }
  if (llm === null) {
    return {
      ok: false,
      message: 'a live chat cell needs the host LLM service',
    };
  }
  if (config.provider === 'session') {
    return {
      ok: false,
      message: `target ${target.targetId} asks for provider "session", which no headless run has`,
    };
  }
  return {
    ok: true,
    backend: {
      kind: 'chat',
      transport: {
        llm: boundedStream({
          llm,
          maxInputTokens: maxInputTokens,
          provider: config.provider,
          model: config.model,
        }),
        chat: {
          provider: config.provider,
          model: config.model,
          temperature: config.temperature,
          maxTokens: config.maxTokens,
          timeoutMs: config.timeoutMs,
          maxRepairRetries: config.maxRepairRetries,
        },
        ...(config.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: config.reasoningEffort }),
        signal: new AbortController().signal,
      },
    },
  };
}

/**
 * The live decision backend for one cell.
 *
 * The credential is resolved through the reader and passed as a value the transport
 * already holds, so the value that authenticates the request is the same one the
 * transport masks. Resolving it here keeps the environment out of the transport,
 * which production deliberately does not read.
 */
function liveDecision(
  target: RunTarget,
  read: (name: string) => string | undefined,
): BackendResult {
  const config = target.decision;
  if (config === null) {
    return {
      ok: false,
      message: `target ${target.targetId} has no decision config`,
    };
  }
  // One resolution rule, shared with the preflight. A target may name a credential on the
  // target or in its decision section, and the two must agree: reading a different variable
  // than the one the preflight checked would either fail every cell after a clean preflight,
  // or authenticate with a credential the plan did not name.
  const consistency = credentialRefOf(target);
  if (!consistency.ok) {
    return { ok: false, message: consistency.message };
  }
  const ref = consistency.ref;
  if (ref.length === 0) {
    return {
      ok: false,
      message: `target ${target.targetId} names no credential reference`,
    };
  }
  const value = read(ref);
  if (value === undefined || value.length === 0) {
    return {
      ok: false,
      message: `credential "${ref}" is not set`,
    };
  }
  return {
    ok: true,
    backend: {
      kind: 'decision',
      transport: {
        fetch: (input, init) => fetch(input, init),
        credentials: undefined,
        preResolvedCredential: { value },
        decision: {
          url: config.url,
          model: config.model,
          apiKeyRef: ref,
          timeoutMs: config.timeoutMs,
          costTier: config.costTier,
        },
        signal: new AbortController().signal,
      },
    },
  };
}

/**
 * Build the backend one cell's review will use, with the caller's own signal.
 *
 * The signal is applied last so the transport always sees the run's lifetime rather
 * than the placeholder each constructor has to supply: an aborted run has to reach
 * the request, and a backend built before the cell started would otherwise carry a
 * signal nobody can abort.
 */
export function backendFor(
  target: RunTarget,
  protocol: RunProtocol,
  context: BackendContext,
): BackendResult {
  let built: BackendResult;
  if (context.transport === 'offline') {
    built =
      context.fixture === null
        ? { ok: false, message: 'an offline cell has no fixture entry' }
        : protocol === 'chat'
          ? offlineChat(target, context.fixture, context.maxInputTokens)
          : offlineDecision(target, context.fixture);
  } else {
    built =
      protocol === 'chat'
        ? liveChat(target, context.llm, context.maxInputTokens)
        : liveDecision(target, context.readCredential);
  }
  if (!built.ok) return built;
  // The transport keeps its configured per-attempt timeout; this signal adds the
  // caller's lifetime on top, and `review` combines the two.
  return {
    ok: true,
    backend:
      built.backend.kind === 'chat'
        ? {
            kind: 'chat',
            transport: { ...built.backend.transport, signal: context.signal },
          }
        : {
            kind: 'decision',
            transport: { ...built.backend.transport, signal: context.signal },
          },
  };
}
