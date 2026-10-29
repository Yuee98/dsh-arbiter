/**
 * Decision answers built for the current contract's two questions.
 *
 * The envelope shapes are the durable facts here, because they are what a provider
 * actually sends: which entry nests its payload under `result`, where `usage` and
 * `errors` sit, and that a native entry has no `success` field at all. The answers
 * themselves are built from the shared rubric rather than copied from a recorded
 * response, because a capture of the previous six-question, eleven-level request
 * would be evidence for a contract this build never asks.
 */

/**
 * A ten-level native distribution, from a sparse map of the levels that hold mass.
 *
 * Absent levels are written as an explicit `0` rather than omitted, because the
 * contract rejects a sparse object: an omitted level has not been reported as
 * anything, so accepting it would invent a total.
 */
function distribution(
  mass: Readonly<Record<number, number>>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (let level = 0; level <= 9; level += 1)
    out[String(level)] = mass[level] ?? 0;
  return out;
}

/** One `score` answer in the shape the new questions are read from. */
function scoreAnswer(mass: Readonly<Record<number, number>>): {
  readonly type: 'score';
  readonly probabilities: Record<string, number>;
} {
  return { type: 'score', probabilities: distribution(mass) };
}

/**
 * A new-scale answer under the Cloudflare envelope.
 *
 * The shapes the new contract asks for, in the envelope a real Cloudflare capture
 * uses: two `score` answers named `risk` and `authorization`, nothing else, plus
 * the usage payload that accompanies them. The numbers are chosen so the two
 * rules N0 fixes are both visible rather than incidentally satisfied:
 *
 *   risk: mass is 0.30 on level 3 and 0.70 on level 4, so the cumulative mass
 *         reaches 1.00 at level 4 and *more than* half only there — public risk 5.
 *   authorization: 0.50 on level 5 and 0.50 on level 6, which is exactly one half
 *         at level 5. Authorization crosses at "at least half", so it lands on
 *         level 5, which is public 6 — the lower of the two adjacent bands.
 */
export const NEW_SCALE_CLOUDFLARE = {
  result: {
    model: 'clef',
    answers: {
      risk: scoreAnswer({ 3: 0.3, 4: 0.7 }),
      authorization: scoreAnswer({ 5: 0.5, 6: 0.5 }),
    },
    usage: {
      input_tokens: 1_200,
      output_tokens: 64,
      total_tokens: 1_264,
    },
  },
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * A new-scale answer at the root, under the native envelope.
 *
 * The same two distributions as {@link NEW_SCALE_CLOUDFLARE}, so a test can assert
 * the two envelopes produce the *same* public scores from the same answers. The
 * usage payload deliberately uses the older snake_case vocabulary, which is what a
 * native entry sends and what the usage mapping reads.
 */
export const NEW_SCALE_TYPESAFE = {
  model: 'jev-1.13.0',
  answers: {
    risk: scoreAnswer({ 3: 0.3, 4: 0.7 }),
    authorization: scoreAnswer({ 5: 0.5, 6: 0.5 }),
  },
  usage: {
    input_tokens: 900,
    output_tokens: 120,
  },
} as const;

/**
 * An answer whose risk distribution has crossed to the top band.
 *
 * Every level 0..8 holds nothing and level 9 holds everything, which is the one
 * distribution where the two N0 rules cannot disagree. It is the fixture for
 * "A10 can permit a high risk": risk 10 with an authorization of 10.
 */
export const NEW_SCALE_RISK_MAX = scoreAnswer({ 9: 1 });

/** The authorization distribution that reaches the highest public band. */
export const NEW_SCALE_AUTHORIZATION_MAX = scoreAnswer({ 9: 1 });

/**
 * A distribution that is complete but does not sum to one.
 *
 * Each level holds a hundredth, so the total is 0.1. This is the case a
 * re-normalizing reader would silently rescue into a score, which is exactly what
 * the contract refuses.
 */
export const NEW_SCALE_LOW_TOTAL = scoreAnswer(
  Object.fromEntries(Array.from({ length: 10 }, (_, level) => [level, 0.01])),
);
