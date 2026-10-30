/**
 * The candidate a run measures, resolved from the plan onto the package seam.
 *
 * RQ-14 froze six candidates as four independent axes and RQ-10's runner had no axis
 * to name one: every cell was production's package, so "compare A with B" could not be
 * expressed as a plan. This module closes that gap by reading the plan's `candidate`
 * member and turning it into the one value that decides both the request and the reader.
 *
 * Two rules are load-bearing:
 *
 *   - the package is the *only* thing a candidate changes. `reviewWith(pkg)` swaps the
 *     renderer and the reader; rendering, sending, N0, the masking boundary and the
 *     outcome mapping stay the same functions. A candidate therefore cannot change what a
 *     score means, only what was asked and how the answer was read.
 *   - an absent candidate is production's own package object, not a re-implementation
 *     with every axis at its baseline. A look-alike baseline would make every difference
 *     attributable to either the treatment or the baseline, which is the one thing an
 *     A/B comparison must not allow.
 */

import {
  PRODUCTION_PACKAGE,
  variantPackage,
} from '../../../src/reviewer/package.js';
import type { ReviewPackage } from '../../../src/reviewer/package.js';
import {
  defineVariant,
  PRODUCTION_VARIANT,
} from '../../../src/reviewer/variant.js';
import type { ReviewVariant } from '../../../src/reviewer/variant.js';

import type { PlanCandidate, RunPlan } from './types.js';

/** One plan's package, resolved. */
export interface ResolvedCandidate {
  /**
   * The short name the plan gave this candidate.
   *
   * `null` when the plan named none, which means "production's package" rather than a
   * candidate called something: inventing a name would let a report print an identifier
   * no document ever used.
   */
  readonly candidateId: string | null;
  /** The derived package identity, so two runs can be compared without re-deriving it. */
  readonly variantId: string;
  /** The package every cell of this run renders and reads with. */
  readonly pkg: ReviewPackage;
  /** The variant, or null when this plan measures production's own package. */
  readonly variant: ReviewVariant | null;
  /** Whether any experiment axis moved away from production. */
  readonly isBaseline: boolean;
}

/** The variant one plan candidate declares. */
export function variantOfCandidate(candidate: PlanCandidate): ReviewVariant {
  return defineVariant({
    prompt: candidate.prompt,
    structure: candidate.structure,
    history: candidate.history,
    scale: candidate.scale,
  });
}

/**
 * The package one plan measures.
 *
 * A plan that names no candidate gets production's own `ReviewPackage` object, so
 * "nothing changed" is the identity of a value rather than a claim about four strings.
 */
export function candidateOf(plan: RunPlan): ResolvedCandidate {
  const declared = plan.candidate;
  if (declared === undefined) {
    return {
      candidateId: null,
      variantId: PRODUCTION_VARIANT.variantId,
      pkg: PRODUCTION_PACKAGE,
      variant: null,
      isBaseline: true,
    };
  }
  const variant = variantOfCandidate(declared);
  return {
    candidateId: declared.candidateId,
    variantId: variant.variantId,
    pkg: variantPackage(variant),
    variant,
    isBaseline: variant.variantId === PRODUCTION_VARIANT.variantId,
  };
}

/**
 * Problems with a plan's candidate declaration.
 *
 * A declared candidate whose axes are all baseline is reported rather than accepted: the
 * axes say "production", so the plan measures nothing and its cells would duplicate a
 * baseline run's while looking like a treatment. The reverse — no declaration — is the
 * baseline and is not a problem.
 */
export function candidateProblems(plan: RunPlan): readonly string[] {
  const declared = plan.candidate;
  if (declared === undefined) return [];
  const variant = variantOfCandidate(declared);
  if (variant.variantId !== PRODUCTION_VARIANT.variantId) return [];
  return [
    `candidate ${declared.candidateId} declares every axis at its baseline, so it measures production's package; omit the candidate to run the baseline, or change an axis`,
  ];
}

/**
 * How a run states which package it measured, in one line.
 *
 * Printed by `plan` and by a dispatch, because "which package ran" is the first thing a
 * reader of a comparison needs and the last thing a record names.
 */
export function candidateSummary(resolved: ResolvedCandidate): string {
  return resolved.candidateId === null
    ? `package ${resolved.variantId} (production)`
    : `candidate ${resolved.candidateId} package ${resolved.variantId}`;
}
