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
import { offlineChatBackend } from '../../src/reviewer/offline.js';
import { REVIEW_PROMPT_VERSION } from '../../src/reviewer/contract.js';
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
