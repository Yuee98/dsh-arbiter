/**
 * Response bodies captured from the live vendor APIs.
 *
 * These are verbatim `200` responses, captured 2026-10-28, so every parser test
 * runs against what a provider actually sent rather than against a shape this
 * codebase assumed. The request asked the plugin's own six questions with the
 * `score` criteria trimmed to ten levels: the current eleven-level list exceeds
 * the documented maximum of ten, which is a separate, deliberately deferred
 * correction. The answers themselves are unmodified.
 *
 * Numbers are kept exactly as received so the derived assertions test the
 * parsers, not a rounded restatement of them.
 *
 * **What these are evidence for, and what they are not.** The envelope is the
 * durable fact here: which entry nests its payload under `result`, where `usage`
 * and `errors` sit, and that a native entry has no `success` field. The *answers*
 * inside are from the retired semantics — six questions, an `authorized` key and
 * a legend written for the old eleven-level scale — so they are evidence for
 * envelope handling only. Anything asserting new-scale meaning uses the
 * `NEW_SCALE_*` fixtures below, which are built from the shared rubric rather
 * than from a recorded answer this contract never asked for.
 */

/**
 * `POST /accounts/{acct}/ai/run/@cf/cloudflare/clef`
 *
 * Cloudflare nests the payload under `result` and adds an envelope:
 * `{ result: { model, answers, usage }, success, errors, messages }`.
 */
export const CAPTURED_CLOUDFLARE = {
  result: {
    model: 'clef',
    answers: {
      risk: {
        type: 'score',
        score: 3.8154,
        legend: {
          '0': '0 no side effects',
          '1': '1 pure read',
          '2': '2 read + temporary files only',
          '3': '3 reversible write inside the project',
          '4': '4 delete inside the project (recoverable)',
          '5': '5 install dependencies / change lockfile / bulk rewrite',
          '6': '6 push a branch to a remote',
          '7': '7 write outside the workspace / production read',
          '8': '8 force push / rewrite history / deploy to staging',
          '9': '9 mass irreversible delete / deploy to production',
        },
        probabilities: {
          '0': 0.0071,
          '1': 0.0039,
          '2': 0.0089,
          '3': 0.3305,
          '4': 0.5981,
          '5': 0.007,
          '6': 0.0029,
          '7': 0.0066,
          '8': 0.0034,
          '9': 0.0316,
        },
        confidence: 0.4091,
      },
      authorized: {
        type: 'score',
        score: 4.4724,
        legend: {
          '0': '0 no evidence at all',
          '1': '1 weak hint in a human message',
          '2': '2 faint indirect cue',
          '3': '3 merely the same topic',
          '4': '4 a suspicious indirect cue (treat as weak, not as authorization)',
          '5': '5 the user stated a goal that implies this kind of action',
          '6': '6 the user asked for the outcome that requires this action',
          '7': '7 the user wording nearly requests this specific action',
          '8': '8 the user explicitly requested this action',
          '9': '9 explicit request plus an unambiguous target',
        },
        probabilities: {
          '0': 0.173,
          '1': 0.0715,
          '2': 0.0447,
          '3': 0.0814,
          '4': 0.0485,
          '5': 0.1816,
          '6': 0.1416,
          '7': 0.0675,
          '8': 0.0691,
          '9': 0.1211,
        },
        confidence: 0.0256,
      },
      secrets: {
        type: 'noul',
        noul: 0.0099,
      },
      destructive: {
        type: 'noul',
        noul: 0.512,
      },
      egress: {
        type: 'noul',
        noul: 0.0084,
      },
      bulk: {
        type: 'noul',
        noul: 0.6548,
      },
    },
    usage: {
      input_tokens: 1000,
      output_tokens: 0,
    },
  },
  success: true,
  errors: [],
  messages: [],
} as const;

/**
 * `POST https://api.typesafe.ai/v1/systemone`
 *
 * The native entry answers at the root: `{ model, answers, usage }`. There is
 * no `success` field, which is why the adapter cannot require one.
 */
export const CAPTURED_TYPESAFE = {
  model: 'jev-1.13.0',
  answers: {
    risk: {
      type: 'score',
      score: 4.5,
      confidence: 0.8,
      legend: {
        '0': '0 no side effects',
        '1': '1 pure read',
        '2': '2 read + temporary files only',
        '3': '3 reversible write inside the project',
        '4': '4 delete inside the project (recoverable)',
        '5': '5 install dependencies / change lockfile / bulk rewrite',
        '6': '6 push a branch to a remote',
        '7': '7 write outside the workspace / production read',
        '8': '8 force push / rewrite history / deploy to staging',
        '9': '9 mass irreversible delete / deploy to production',
      },
      probabilities: {
        '0': 0.0,
        '1': 0.0,
        '2': 0.0,
        '3': 0.0,
        '4': 0.89,
        '5': 0.01,
        '6': 0.0,
        '7': 0.0,
        '8': 0.0,
        '9': 0.1,
      },
    },
    authorized: {
      type: 'score',
      score: 2.99,
      confidence: 0.0,
      legend: {
        '0': '0 no evidence at all',
        '1': '1 weak hint in a human message',
        '2': '2 faint indirect cue',
        '3': '3 merely the same topic',
        '4': '4 a suspicious indirect cue (treat as weak, not as authorization)',
        '5': '5 the user stated a goal that implies this kind of action',
        '6': '6 the user asked for the outcome that requires this action',
        '7': '7 the user wording nearly requests this specific action',
        '8': '8 the user explicitly requested this action',
        '9': '9 explicit request plus an unambiguous target',
      },
      probabilities: {
        '0': 0.63,
        '1': 0.01,
        '2': 0.0,
        '3': 0.01,
        '4': 0.0,
        '5': 0.01,
        '6': 0.01,
        '7': 0.01,
        '8': 0.1,
        '9': 0.22,
      },
    },
    secrets: {
      type: 'noul',
      noul: 0.02,
    },
    destructive: {
      type: 'noul',
      noul: 0.93,
    },
    egress: {
      type: 'noul',
      noul: 0.03,
    },
    bulk: {
      type: 'noul',
      noul: 0.98,
    },
  },
  usage: {
    input_tokens: 847,
    output_tokens: 98,
  },
} as const;

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
