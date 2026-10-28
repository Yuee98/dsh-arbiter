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
