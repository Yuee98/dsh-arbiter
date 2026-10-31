/**
 * Production and evals run the same package and the same reader by default.
 *
 * RQ-16's acceptance condition is that one default configuration produces one
 * rendering and one public score, "not simulated by a second copy of the code". The
 * claim is stronger than "the two paths agree on a fixture": it says the *object* the
 * evals runner measures when a plan names no candidate is production's own package,
 * and that everything downstream of the renderer is one implementation.
 *
 * Three facts are asserted here, each at the seam where it could stop being true:
 *
 *   1. identity — a plan with no candidate resolves to `PRODUCTION_PACKAGE` itself, not
 *      to a variant package whose four axes happen to be at their baseline. A
 *      look-alike baseline would silently turn every A/B comparison into "the
 *      treatment versus another copy of the treatment".
 *   2. bytes — production's `review()` and the evals material builder send the same
 *      request for the same snapshot, because both call the same renderer.
 *   3. scoring — the same answer text scores identically through both entry points,
 *      because both reach `readProtocolScores` and N0.
 *
 * What is deliberately not asserted: that the two *inputs* are equal. Production
 * assembles material from the host's session log and evals assembles it from a case
 * file, and pretending those are the same input would be the false claim.
 */

import { describe, expect, it } from 'vitest';

import { caseMaterial } from '../../evals/src/run/material.js';
import { candidateOf } from '../../evals/src/run/candidate.js';
import { planOf } from './helpers/run.js';
import { coreCases } from './helpers/report-run.js';
import { review, reviewWith } from '../../src/reviewer/service.js';
import { PRODUCTION_PACKAGE } from '../../src/reviewer/package.js';
import { renderChatRequest } from '../../src/reviewer/prompt.js';
import { PRODUCTION_VARIANT } from '../../src/reviewer/variant.js';
import {
  offlineChatBackend,
  offlineDecisionBackend,
} from '../../src/reviewer/offline.js';
import { digestOf } from '../../evals/src/data/hash.js';
import {
  CHAT_PROTOCOL,
  DECISION_PROTOCOL,
  REVIEW_PROMPT_VERSION,
} from '../../src/reviewer/contract.js';
import { REVIEW_CONTRACT_VERSION } from '../../src/review-contract/index.js';

describe('the default candidate is production’s own package', () => {
  it('resolves a plan with no candidate to the production package object', () => {
    const resolved = candidateOf(planOf());
    // Identity, not equality: the same object is what makes "production ran" a fact
    // about a value rather than a claim about four strings.
    expect(resolved.pkg).toBe(PRODUCTION_PACKAGE);
    expect(resolved.variant).toBeNull();
    expect(resolved.isBaseline).toBe(true);
    expect(resolved.variantId).toBe(PRODUCTION_VARIANT.variantId);
  });

  it('production’s package asks no probe, which is candidate A', () => {
    // The decision recorded in #83: both protocols use the no-probe prompt. The
    // production variant names it and the package states it, and the two agree.
    expect(PRODUCTION_VARIANT.prompt).toBe('no-probe');
    expect(PRODUCTION_PACKAGE.asksProbe).toBe(false);
    expect(PRODUCTION_VARIANT.variantId).toBe(
      'rq14/no-probe.complete.current-turn.full',
    );
  });

  it('production’s package members are the production functions themselves', () => {
    // Nothing here is a copy to keep in step: every renderer and reader is the
    // function production exports, so a change to production cannot leave the
    // baseline behind.
    expect(PRODUCTION_PACKAGE.renderChat).toBe(renderChatRequest);
  });

  it('names the versions a record can be traced by', () => {
    // Both are compiled constants, so a run's records can state which prompt and
    // which contract produced a number rather than only "some build".
    expect(REVIEW_PROMPT_VERSION).toBe('review-prompt-v1');
    expect(REVIEW_CONTRACT_VERSION).toBe('review-contract-v1');
  });
});

describe('the same snapshot renders to the same request on both paths', () => {
  it('the evals material builder sends production’s chat bytes', async () => {
    const loaded = await coreCases();
    const entry = loaded.cases.find(
      (candidate) => candidate.caseId === 'read-named-source-file',
    );
    if (entry === undefined) throw new Error('expected the core case');
    const material = caseMaterial(entry, 'chat', { maxInputTokens: 10_000 });
    // No `pkg` was passed, so the builder used production's package; the request it
    // stored is byte-for-byte what production's own renderer produces for that
    // snapshot.
    expect(material.request).toEqual(renderChatRequest(material.snapshot));
  });

  it('the decision request likewise comes from production’s renderer', async () => {
    const loaded = await coreCases();
    const entry = loaded.cases.find(
      (candidate) => candidate.caseId === 'read-named-source-file',
    );
    if (entry === undefined) throw new Error('expected the core case');
    const material = caseMaterial(entry, 'decision', {
      maxInputTokens: 10_000,
    });
    expect(material.request).toEqual(
      PRODUCTION_PACKAGE.renderDecision(material.snapshot),
    );
  });
});

/** One chat answer, the pair the matrix reads. */
const CHAT_ANSWER = JSON.stringify({ risk: 6, authorization: 3 });

/** One decision answer body, in the native envelope a real endpoint returns. */
const DECISION_ANSWER: {
  readonly status: number;
  readonly body: string;
} = {
  status: 200,
  body: JSON.stringify({
    model: 'offline-decision',
    answers: {
      risk: {
        type: 'score',
        probabilities: {
          '0': 0,
          '1': 0,
          '2': 0,
          '3': 0,
          '4': 0,
          '5': 0,
          '6': 1,
          '7': 0,
          '8': 0,
          '9': 0,
        },
      },
      authorization: {
        type: 'score',
        probabilities: {
          '0': 0,
          '1': 0,
          '2': 0,
          '3': 0,
          '4': 0,
          '5': 0,
          '6': 0,
          '7': 0,
          '8': 0,
          '9': 1,
        },
      },
    },
  }),
};

describe('the production request fingerprint is reproducible from the stored snapshot', () => {
  // RQ16-B01. The evals record carries `promptFingerprint`; production does not. The
  // link that closes the gap is not a new column: production's audit store already
  // persists the complete `ReviewSnapshot` (`src/audit/writer.ts:89` writes
  // `record.snapshot` into `snapshots.content`), and the renderer is deterministic. So
  // the same canonical digest the run record names can be re-derived from a production
  // snapshot, on the same build, with no model call and no schema change.
  //
  // What is *not* claimed: that production could have recomputed it from the stored
  // attempt. The attempt's `request` has crossed the credential mask (`maskAttempt`), so
  // its bytes differ by design. The snapshot is the unmasked boundary; the attempt is
  // not.
  async function fingerprintFromSnapshot(
    protocol: 'chat' | 'decision',
  ): Promise<{
    readonly recorded: string;
    readonly fromSnapshot: string;
    readonly fromStoredAttempt: string;
  }> {
    const loaded = await coreCases();
    const entry = loaded.cases.find(
      (candidate) => candidate.caseId === 'read-named-source-file',
    );
    if (entry === undefined) throw new Error('expected the core case');
    const material = caseMaterial(entry, protocol, { maxInputTokens: 10_000 });
    // The fingerprint the evals record actually carries, not one this test recomputes:
    // recomputing it here would make the assertion tautological and unable to notice a
    // change in what `caseMaterial` hashes.
    const recorded = material.material.promptFingerprint;
    const result = await review({
      snapshot: material.snapshot,
      callId: 'call-1',
      signal: new AbortController().signal,
      backend:
        protocol === 'chat'
          ? offlineChatBackend({
              scripts: [{ kind: 'text', text: CHAT_ANSWER }],
            })
          : offlineDecisionBackend({ scripts: [DECISION_ANSWER] }),
    });
    const attempt = result.attempts[0];
    if (attempt === undefined) throw new Error('expected one attempt');
    // The unmasked boundary: re-render the snapshot the audit store would keep.
    const rerendered =
      protocol === 'chat'
        ? PRODUCTION_PACKAGE.renderChat(material.snapshot)
        : PRODUCTION_PACKAGE.renderDecision(material.snapshot);
    const fromSnapshot = digestOf({ protocol, request: rerendered });
    // The masked copy, for contrast: this is why the attempt cannot be the source.
    const fromStoredAttempt = digestOf({
      protocol:
        attempt.protocol === CHAT_PROTOCOL
          ? 'chat'
          : attempt.protocol === DECISION_PROTOCOL
            ? 'decision'
            : attempt.protocol,
      request: attempt.request,
    });
    return { recorded, fromSnapshot, fromStoredAttempt };
  }

  it.each(['chat', 'decision'] as const)(
    'the %s fingerprint re-derives from the stored snapshot',
    async (protocol) => {
      const { recorded, fromSnapshot } =
        await fingerprintFromSnapshot(protocol);
      // The correlation RQ-16 asks for: a production snapshot and an evals record name
      // the same canonical digest for the same input.
      expect(fromSnapshot).toBe(recorded);
    },
  );

  it('the masked attempt is not a fingerprint source, by design', async () => {
    // Stated as an assertion rather than a comment so a future change that makes the
    // two agree has to update this deliberately.
    for (const protocol of ['chat', 'decision'] as const) {
      const { recorded, fromStoredAttempt } =
        await fingerprintFromSnapshot(protocol);
      expect(fromStoredAttempt).not.toBe(recorded);
    }
  });
});

describe('the same answer scores identically through both entry points', () => {
  /**
   * The two calls the two paths actually make.
   *
   * Production calls `review()`, which hard-codes `PRODUCTION_PACKAGE`; the evals
   * runner calls `reviewWith(pkg)` with the package the plan resolved. Comparing these
   * two — rather than two `review()` calls — is what covers the seam the runner added.
   */
  async function scoreThroughBothPaths(answer: string): Promise<{
    readonly production: Awaited<ReturnType<typeof review>>['outcome'];
    readonly evals: Awaited<ReturnType<typeof review>>['outcome'];
  }> {
    const loaded = await coreCases();
    const entry = loaded.cases[0];
    if (entry === undefined) throw new Error('expected at least one core case');
    const material = caseMaterial(entry, 'chat', { maxInputTokens: 10_000 });
    const request = {
      snapshot: material.snapshot,
      callId: 'call-1',
      signal: new AbortController().signal,
    } as const;
    const production = await review({
      ...request,
      backend: offlineChatBackend({
        scripts: [{ kind: 'text', text: answer }],
      }),
    });
    // The evals runner's own dispatch shape: the resolved package, not `review()`.
    const evals = await reviewWith(candidateOf(planOf()).pkg)({
      ...request,
      backend: offlineChatBackend({
        scripts: [{ kind: 'text', text: answer }],
      }),
    });
    return { production: production.outcome, evals: evals.outcome };
  }

  it('one chat answer gives one risk, authorization and verdict', async () => {
    const { production, evals } = await scoreThroughBothPaths(
      JSON.stringify({ risk: 6, authorization: 3 }),
    );
    expect(production).toEqual(evals);
    expect(production.status).toBe('scored');
    if (production.status !== 'scored') throw new Error('expected a score');
    // The matrix reads the pair, so an identical outcome includes the verdict and the
    // threshold — not only the two numbers.
    expect(production.risk).toBe(6);
    expect(production.authorization).toBe(3);
    expect(production.requiredAuthorization).toBe(9);
    expect(production.verdict).toBe('review-escalate');
  });

  it('one unreadable answer fails identically on both paths', async () => {
    // Agreement on success is half the claim; a candidate that failed differently
    // would let a comparison attribute a failure to the treatment.
    const { production, evals } = await scoreThroughBothPaths('not an answer');
    expect(production).toEqual(evals);
    expect(production.status).toBe('review-failure');
  });
});

describe('a decision answer scores identically through both entry points', () => {
  // RQ16-B02. The normalization repair is a *decision*-protocol change, so chat parity
  // alone would not cover the acceptance criterion. The two distributions below are the
  // ones the repair moves:
  //
  //   boundary   exactly on the tolerance: decimal 0.9999, accepted after the fix and
  //              rejected before it. This is the answer the S1 pilot lost.
  //   outside    decimal 1.0002, still rejected. It proves the fix did not widen the
  //              bound in the same run that proves it rescued the boundary.
  const BOUNDARY: Record<string, number> = {
    '0': 0.0276,
    '1': 0.07,
    '2': 0.1349,
    '3': 0.2086,
    '4': 0.1692,
    '5': 0.1261,
    '6': 0.083,
    '7': 0.0638,
    '8': 0.055,
    '9': 0.0617,
  };
  const OUTSIDE: Record<string, number> = { ...BOUNDARY, '9': 0.062 };
  const POINT_A10: Record<string, number> = {
    '0': 0,
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0,
    '6': 0,
    '7': 0,
    '8': 0,
    '9': 1,
  };

  /** The native decision envelope a real endpoint returns. */
  function decisionBody(
    risk: Record<string, number>,
    authorization: Record<string, number>,
  ): string {
    return JSON.stringify({
      model: 'offline-decision',
      answers: {
        risk: { type: 'score', probabilities: risk },
        authorization: { type: 'score', probabilities: authorization },
      },
    });
  }

  async function decideThroughBothPaths(
    risk: Record<string, number>,
    authorization: Record<string, number>,
  ): Promise<{
    readonly production: Awaited<ReturnType<typeof review>>;
    readonly evals: Awaited<ReturnType<typeof review>>;
    readonly productionRequest: unknown;
    readonly evalsRequest: unknown;
  }> {
    const loaded = await coreCases();
    const entry = loaded.cases[0];
    if (entry === undefined) throw new Error('expected at least one core case');
    const material = caseMaterial(entry, 'decision', {
      maxInputTokens: 10_000,
    });
    const body = decisionBody(risk, authorization);
    // Each call records the request body the adapter actually sent, so the two can be
    // compared as bytes rather than as expectations.
    const productionRequests: unknown[] = [];
    const evalsRequests: unknown[] = [];
    const production = await review({
      snapshot: material.snapshot,
      callId: 'call-1',
      signal: new AbortController().signal,
      backend: offlineDecisionBackend({
        scripts: [{ status: 200, body }],
        requests: productionRequests,
      }),
    });
    const evals = await reviewWith(candidateOf(planOf()).pkg)({
      snapshot: material.snapshot,
      callId: 'call-1',
      signal: new AbortController().signal,
      backend: offlineDecisionBackend({
        scripts: [{ status: 200, body }],
        requests: evalsRequests,
      }),
    });
    return {
      production,
      evals,
      productionRequest: productionRequests[0],
      evalsRequest: evalsRequests[0],
    };
  }

  it('the exactly-on-boundary answer is scored, and identically on both paths', async () => {
    const { production, evals, productionRequest, evalsRequest } =
      await decideThroughBothPaths(BOUNDARY, POINT_A10);
    // The wire request is one value, not two renderings that happen to agree.
    expect(productionRequest).toEqual(evalsRequest);
    expect(production.outcome).toEqual(evals.outcome);
    expect(production.outcome.status).toBe('scored');
    if (production.outcome.status !== 'scored') {
      throw new Error('expected a scored decision answer');
    }
    // The repair reaches the score: this distribution is the one the float rule
    // refused, and its N0 band is 5.
    expect(production.outcome.risk).toBe(5);
    // Risk 5 requires A9, and this answer gives A10, so the matrix allows. Asserting the
    // verdict rather than only the bands is what proves the two paths agree on the
    // *decision*, not just on the numbers.
    expect(production.outcome.requiredAuthorization).toBe(9);
    expect(production.outcome.authorization).toBe(10);
    expect(production.outcome.verdict).toBe('review-allow');
    // Both paths keep the submitted distribution for the audit, so a report reading
    // either record sees the same numbers.
    expect(production.outcome.audit.risk.native).toEqual(BOUNDARY);
    // Both paths keep the submitted distribution, and `toEqual` already established the
    // whole outcome matches; naming the audit makes the reason explicit rather than
    // implied.
    const evalAudit =
      evals.outcome.status === 'scored' ? evals.outcome.audit : null;
    expect(evalAudit).toEqual(production.outcome.audit);
  });

  it('a genuinely out-of-tolerance answer fails identically on both paths', async () => {
    const { production, evals, productionRequest, evalsRequest } =
      await decideThroughBothPaths(OUTSIDE, POINT_A10);
    expect(productionRequest).toEqual(evalsRequest);
    expect(production.outcome).toEqual(evals.outcome);
    expect(production.outcome.status).toBe('review-failure');
    if (production.outcome.status !== 'review-failure') {
      throw new Error('expected a rejection');
    }
    // The failure classification is part of what must agree: a candidate that failed
    // with a different reason would make the two paths incomparable.
    expect(production.outcome.reason).toContain('probability-sum-not-one');
    expect(
      evals.outcome.status === 'review-failure' && evals.outcome.reason,
    ).toBe(production.outcome.reason);
    // No score is invented on either side.
    expect(production.outcome).not.toHaveProperty('risk');
    expect(evals.outcome).not.toHaveProperty('risk');
  });
});
