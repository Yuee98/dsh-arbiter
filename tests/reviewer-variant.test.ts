/**
 * The controlled package variants, and the rule that a probe changes no band.
 *
 * These cases pin the four claims the experiment depends on:
 *
 *   - the variant vocabulary is closed and its identity is derivable, so two candidates
 *     cannot name one package;
 *   - production's package is what `review()` renders, and the variant entry point is a
 *     different function, so an experiment cannot change the default;
 *   - a probe answer never reaches the outcome, and an unreadable probe never turns a
 *     readable answer into a failure;
 *   - the compressed scale keeps the guard rails that make the scale usable.
 */

import { describe, expect, test } from 'vitest';

import { review } from '../src/reviewer/service.js';
import { offlineChatBackend } from '../src/reviewer/offline.js';
import {
  defineVariant,
  isProductionVariant,
  parseVariantId,
  productionDiff,
  PRODUCTION_VARIANT,
  variantDiff,
  variantIdFor,
} from '../src/reviewer/variant.js';
import type { ReviewVariant, VariantAxes } from '../src/reviewer/variant.js';
import {
  CHAT_PROBE_ANSWER_FORMAT,
  PROBE_MEMBER,
  PROBE_OPTIONS,
  probeDecisionQuestion,
  readProbeAnswer,
  RECOVERABILITY_PROBE_QUESTION,
  REVIEW_PROBE_VERSION,
} from '../src/reviewer/probe.js';
import {
  renderChatRequest,
  renderChatSystem,
  renderVariantChatRequest,
  renderVariantChatSystem,
  renderVariantQuestions,
} from '../src/reviewer/prompt.js';
import {
  buildQuestions,
  SCORE_CRITERIA_MAX,
} from '../src/reviewer/questions.js';
import { readChatAnswer } from '../src/reviewer/signals.js';
import { readVariantChatAnswer } from '../src/reviewer/variant-signals.js';
import {
  PRODUCTION_PACKAGE,
  probeOfAttempt,
  probesOf,
  variantPackage,
} from '../src/reviewer/package.js';
import { compressQuestions, SCALE_GUARD } from '../src/reviewer/scale.js';
import type { ReviewSnapshot } from '../src/types.js';

const SNAPSHOT: ReviewSnapshot = {
  version: 1,
  createdAt: 0,
  configRevision: 'rev-1',
  callId: 'call-1',
  sessionId: 'main',
  sessionKind: 'main',
  turn: 4,
  tool: 'bash',
  cwd: '/work/project',
  action: { name: 'bash', arguments: { command: 'rm -rf build' } },
  facts: null,
  hint: 'the user asked about cleaning the build directory',
  projectRules: 'PROJECT: never touch /etc',
  customRules: 'CUSTOM: prefer pnpm',
  materials: [
    {
      id: 'project-rules',
      enabled: true,
      present: true,
      chars: 22,
      limit: 2_000,
      truncated: false,
    },
    {
      id: 'custom-rules',
      enabled: true,
      present: true,
      chars: 17,
      limit: 2_000,
      truncated: false,
    },
  ],
  evidence: [
    {
      ts: 10,
      source: { kind: 'session-human', sessionId: 'main' },
      role: 'human-instruction',
      evidence: 'explicit',
      sourcePriority: 1,
      text: 'clean the build directory',
      turn: 4,
    },
  ],
  evidenceTruncated: false,
  parentAuthorizationPresent: false,
  context: [{ ts: 1, tool: 'bash', arguments: '{"command":"ls"}' }],
  checkpoints: [],
  contextTruncated: false,
  priorVerdicts: [],
  historyTruncated: false,
  historyStatus: {
    coverage: 'complete',
    windowTruncated: false,
    reason: null,
    sources: {
      memory: { read: 0, unavailable: null },
      session: { read: 1, unavailable: null },
      audit: { read: 0, unavailable: null },
    },
    reset: false,
  },
  completeness: { status: 'complete', items: [], gaps: [], note: null },
  missing: [],
  budget: {
    maxInputTokens: 10_000,
    estimatedInputTokens: 0,
    truncatedSegments: [],
  },
};

/** The production axes, spelled out so a test can state a single change. */
const BASE_AXES: VariantAxes = {
  prompt: 'no-probe',
  structure: 'full',
  history: 'current-turn',
  scale: 'complete',
};

function variantOf(overrides: Partial<VariantAxes> = {}): ReviewVariant {
  return defineVariant({ ...BASE_AXES, ...overrides });
}

describe('variant identity', () => {
  test('is derived from the four axes and round-trips', () => {
    const variant = variantOf({ prompt: 'recovery-probe' });
    expect(variant.variantId).toBe(
      'rq14/recovery-probe.complete.current-turn.full',
    );
    expect(variantIdFor(variant)).toBe(variant.variantId);
  });

  test('parses every id this module can produce', () => {
    const axes: VariantAxes[] = [
      BASE_AXES,
      { ...BASE_AXES, prompt: 'recovery-probe' },
      { ...BASE_AXES, structure: 'compact' },
      { ...BASE_AXES, structure: 'compact-no-audit' },
      { ...BASE_AXES, history: 'none' },
      { ...BASE_AXES, scale: 'labels' },
    ];
    const parsed = axes.map((entry) => parseVariantId(variantIdFor(entry)));
    // Every id this vocabulary can produce round-trips to the axes it names.
    expect(parsed.map((entry) => entry.ok)).toEqual(axes.map(() => true));
    expect(parsed.map((entry) => (entry.ok ? entry.axes : null))).toEqual(axes);
  });

  test('refuses an id that names no package', () => {
    for (const id of [
      'rq14/no-probe.complete.current-turn',
      'rq14/no-probe.complete.current-turn.partial',
      'rq14/probe.complete.current-turn.full',
      'rq13/no-probe.complete.current-turn.full',
      '',
    ]) {
      expect(parseVariantId(id).ok).toBe(false);
    }
  });

  test('differs two packages by exactly the axes that changed', () => {
    expect(variantDiff(PRODUCTION_VARIANT, variantOf())).toEqual([]);
    expect(
      variantDiff(PRODUCTION_VARIANT, variantOf({ prompt: 'recovery-probe' })),
    ).toEqual(['prompt']);
    expect(
      variantDiff(
        variantOf(),
        variantOf({ prompt: 'recovery-probe', scale: 'labels' }),
      ),
    ).toEqual(['prompt', 'scale']);
    expect(productionDiff(variantOf({ structure: 'compact' }))).toEqual([
      'structure',
    ]);
  });

  test('names production, and only production', () => {
    expect(isProductionVariant(PRODUCTION_VARIANT)).toBe(true);
    expect(isProductionVariant(variantOf({ structure: 'compact' }))).toBe(
      false,
    );
    expect(PRODUCTION_VARIANT.prompt).toBe('no-probe');
  });
});

describe('the probe definition', () => {
  test('is a closed vocabulary that separates withdrawal, recovery and residual', () => {
    expect(PROBE_OPTIONS).toEqual([
      'withdrawn',
      'recoverable',
      'partially-recoverable',
      'irreversible',
      'unknown',
    ]);
    expect(PROBE_MEMBER).toBe('recoverability');
  });

  test('reads only a legal option, folding case and space', () => {
    expect(readProbeAnswer('recoverable')).toEqual({
      status: 'answered',
      option: 'recoverable',
      raw: 'recoverable',
    });
    expect(readProbeAnswer('  Recoverable ').status).toBe('answered');
    // `unknown` is an answer, not a missing value.
    expect(readProbeAnswer('unknown')).toEqual({
      status: 'answered',
      option: 'unknown',
      raw: 'unknown',
    });
  });

  test('keeps "no legal option" distinct from "no answer at all"', () => {
    expect(readProbeAnswer(undefined)).toEqual({
      status: 'unknown',
      reason: 'member-absent',
    });
    expect(readProbeAnswer(42)).toEqual({
      status: 'unknown',
      reason: 'not-a-string',
    });
    expect(readProbeAnswer('mostly-fine')).toEqual({
      status: 'unknown',
      reason: 'not-an-option',
    });
  });

  test('states the question once, without restating a band or the matrix', () => {
    // A probe that carried an anchor could be read as a second, competing scale.
    expect(RECOVERABILITY_PROBE_QUESTION).not.toContain('A8');
    expect(RECOVERABILITY_PROBE_QUESTION).not.toContain(
      'requiredAuthorization',
    );
    expect(RECOVERABILITY_PROBE_QUESTION).toContain('never part of them');
    for (const option of PROBE_OPTIONS) {
      expect(RECOVERABILITY_PROBE_QUESTION).toContain(`- ${option}:`);
    }
  });

  test('asks the decision endpoint a choice question, not a third score', () => {
    const question = probeDecisionQuestion();
    expect(question.type).toBe('choice');
    expect(question.instructions).toBe(RECOVERABILITY_PROBE_QUESTION);
  });

  test('has a version a stored record can name', () => {
    expect(REVIEW_PROBE_VERSION).toBe('review-probe-v1');
  });
});

describe('candidate B renders the probe and nothing else', () => {
  test('adds the question and the three-member answer shape to the system message', () => {
    const probe = variantOf({ prompt: 'recovery-probe' });
    const system = renderVariantChatSystem(probe);
    expect(system).toContain(RECOVERABILITY_PROBE_QUESTION);
    expect(system).toContain(CHAT_PROBE_ANSWER_FORMAT);
    expect(system).toContain('"recoverability"');
  });

  test('candidate A keeps production’s exact system message', () => {
    // A is the baseline; if it renders anything else, the comparison is between two
    // treatments rather than against production.
    expect(renderVariantChatSystem(variantOf())).toBe(renderChatSystem());
    expect(renderVariantChatRequest(SNAPSHOT, variantOf())).toEqual(
      renderChatRequest(SNAPSHOT),
    );
  });

  test('the probe is the only difference between A and B', () => {
    const a = renderVariantChatRequest(SNAPSHOT, variantOf());
    const b = renderVariantChatRequest(
      SNAPSHOT,
      variantOf({ prompt: 'recovery-probe' }),
    );
    // The submitted material is byte-identical: the probe changes the question, never
    // the evidence a reviewer judges.
    expect(a.user).toBe(b.user);
    expect(
      b.system.startsWith(a.system.slice(0, a.system.lastIndexOf('## Answer'))),
    ).toBe(true);
  });

  test('keeps the two score questions unchanged in the decision protocol', () => {
    const production = buildQuestions();
    const withProbe = renderVariantQuestions(
      variantOf({ prompt: 'recovery-probe' }),
    );
    expect(withProbe.risk).toEqual(production.risk);
    expect(withProbe.authorization).toEqual(production.authorization);
    // The probe is its own question; it never becomes an eleventh criterion.
    expect(Object.keys(withProbe)).toEqual([
      'risk',
      'authorization',
      'recoverability',
    ]);
    expect(withProbe.risk.criteria).toHaveLength(SCORE_CRITERIA_MAX);
  });

  test('candidate A adds no question at all', () => {
    expect(renderVariantQuestions(variantOf())).toEqual(buildQuestions());
  });
});

describe('the probe never reaches a score', () => {
  test('a readable probe leaves the production reading untouched', () => {
    const answer = readVariantChatAnswer(
      JSON.stringify({
        risk: 4,
        authorization: 7,
        recoverability: 'recoverable',
      }),
    );
    expect(answer.scored.ok).toBe(true);
    expect(answer.probe).toEqual({
      status: 'answered',
      option: 'recoverable',
      raw: 'recoverable',
    });
    // The production reader would have rejected the third member; the wrapper removes it
    // and hands on exactly what production reads.
    expect(
      readChatAnswer(
        JSON.stringify({
          risk: 4,
          authorization: 7,
          recoverability: 'recoverable',
        }),
      ).ok,
    ).toBe(false);
  });

  test('an unreadable probe leaves a readable answer readable', () => {
    const answer = readVariantChatAnswer(
      JSON.stringify({ risk: 4, authorization: 7, recoverability: 'fine' }),
    );
    expect(answer.scored.ok).toBe(true);
    expect(answer.probe).toEqual({
      status: 'unknown',
      reason: 'not-an-option',
    });
  });

  test('a missing probe is reported as absent, not as unknown', () => {
    const answer = readVariantChatAnswer(
      JSON.stringify({ risk: 4, authorization: 7 }),
    );
    expect(answer.scored.ok).toBe(true);
    expect(answer.probe).toEqual({
      status: 'unknown',
      reason: 'member-absent',
    });
  });

  test('a bad score is still a failure, with the probe kept beside it', () => {
    const answer = readVariantChatAnswer(
      JSON.stringify({ risk: 11, authorization: 7, recoverability: 'unknown' }),
    );
    expect(answer.scored.ok).toBe(false);
    expect(answer.probe.status).toBe('answered');
  });

  test('a body that is not an object is the production failure', () => {
    const answer = readVariantChatAnswer('not json at all');
    expect(answer.scored).toEqual(readChatAnswer('not json at all'));
    expect(answer.probe).toEqual({
      status: 'unknown',
      reason: 'member-absent',
    });
  });

  test('a variant that asked no probe rejects a third member', () => {
    // Tolerating one would mean accepting an answer production's reader rejected.
    const pkg = variantPackage(variantOf());
    expect(pkg.asksProbe).toBe(false);
    expect(
      pkg.readChat(
        JSON.stringify({
          risk: 3,
          authorization: 5,
          recoverability: 'unknown',
        }),
      ).ok,
    ).toBe(false);
  });

  test('reports not-asked for a probe-free package and absent for a bodyless attempt', () => {
    expect(
      probeOfAttempt({
        probeAsked: false,
        backend: 'chat',
        responseText: '{"risk":3}',
        parsed: null,
      }),
    ).toEqual({ status: 'not-asked' });
    expect(
      probeOfAttempt({
        probeAsked: true,
        backend: 'chat',
        responseText: null,
        parsed: null,
      }),
    ).toEqual({ status: 'unknown', reason: 'member-absent' });
  });

  test('reads the decision probe from its own answer member', () => {
    expect(
      probeOfAttempt({
        probeAsked: true,
        backend: 'decision',
        responseText: null,
        parsed: {
          answers: {
            risk: { probabilities: {} },
            recoverability: { choice: 'irreversible' },
          },
        },
      }),
    ).toEqual({
      status: 'answered',
      option: 'irreversible',
      raw: 'irreversible',
    });
    expect(
      probeOfAttempt({
        probeAsked: true,
        backend: 'decision',
        responseText: null,
        parsed: { answers: { risk: { probabilities: {} } } },
      }),
    ).toEqual({ status: 'unknown', reason: 'member-absent' });
  });
});

describe('the service keeps production and experiments apart', () => {
  test('reviews through the production package and reports no probe', async () => {
    const result = await review({
      snapshot: SNAPSHOT,
      callId: 'call-1',
      signal: new AbortController().signal,
      backend: offlineChatBackend({
        scripts: [{ kind: 'text', text: '{"risk":4,"authorization":7}' }],
      }),
    });
    expect(result.outcome.status).toBe('scored');
    // The production package asks no probe, so every attempt reads `not-asked`.
    expect(probesOf(PRODUCTION_PACKAGE, result.attempts)).toEqual([
      { status: 'not-asked' },
    ]);
  });

  test('keeps the probe out of the outcome on a variant package', async () => {
    const { reviewWith } = await import('../src/reviewer/service.js');
    const pkg = variantPackage(variantOf({ prompt: 'recovery-probe' }));
    const run = reviewWith(pkg);
    const result = await run({
      snapshot: SNAPSHOT,
      callId: 'call-b',
      signal: new AbortController().signal,
      backend: offlineChatBackend({
        scripts: [
          {
            kind: 'text',
            text: '{"risk":4,"authorization":7,"recoverability":"irreversible"}',
          },
        ],
      }),
    });
    expect(result.outcome.status).toBe('scored');
    // `irreversible` is an answer beside the bands, never a gate on them: the two bands
    // are what the production reader read from the same bytes.
    expect(result.outcome).toMatchObject({ risk: 4, authorization: 7 });
    // Re-derived from the stored attempt, which is what a record's reader does too.
    expect(probesOf(pkg, result.attempts)).toEqual([
      { status: 'answered', option: 'irreversible', raw: 'irreversible' },
    ]);
  });

  test('reports the same outcome for the same two bands across candidates', async () => {
    const { reviewWith } = await import('../src/reviewer/service.js');
    const text = '{"risk":6,"authorization":3}';
    const productionResult = await review({
      snapshot: SNAPSHOT,
      callId: 'call-p',
      signal: new AbortController().signal,
      backend: offlineChatBackend({ scripts: [{ kind: 'text', text }] }),
    });
    const variantResult = await reviewWith(
      variantPackage(variantOf({ prompt: 'recovery-probe' })),
    )({
      snapshot: SNAPSHOT,
      callId: 'call-v',
      signal: new AbortController().signal,
      backend: offlineChatBackend({
        scripts: [
          {
            kind: 'text',
            text: '{"risk":6,"authorization":3,"recoverability":"unknown"}',
          },
        ],
      }),
    });
    expect(variantResult.outcome).toEqual(productionResult.outcome);
  });
});

describe('the compressed scale keeps its guard rails', () => {
  test('states prohibition, cumulativity, weakest-part and recovery-in-risk', () => {
    expect(SCALE_GUARD).toContain('prohibition');
    expect(SCALE_GUARD).toContain('withdrawal');
    expect(SCALE_GUARD).toContain('cumulative');
    expect(SCALE_GUARD).toContain('caps the whole operation at band 2');
    // The design's own sentence for candidate B, restated so compression cannot change
    // the risk definition.
    expect(SCALE_GUARD).toContain(
      'Recovery cost and residual harm stay inside',
    );
  });

  test('compresses the criteria to one line each, keeping ten of them', () => {
    const complete = buildQuestions();
    const compressed = compressQuestions(complete);
    expect(compressed.risk.criteria).toHaveLength(SCORE_CRITERIA_MAX);
    expect(compressed.authorization.criteria).toHaveLength(SCORE_CRITERIA_MAX);
    // The native numbering is kept: the endpoint validates the level keys.
    expect(compressed.risk.criteria[0]?.startsWith('0 ')).toBe(true);
    expect(compressed.risk.criteria[9]?.startsWith('9 ')).toBe(true);
    // The guard is appended, never substituted for the instructions.
    expect(
      compressed.risk.instructions.startsWith(complete.risk.instructions),
    ).toBe(true);
    expect(compressed.risk.instructions).toContain(SCALE_GUARD);
    // Compression shortens the band text without dropping a band.
    const shorter = compressed.risk.criteria.join('').length;
    expect(shorter).toBeLessThan(complete.risk.criteria.join('').length);
  });

  test('prints the same guard on the chat scale', async () => {
    const { renderLabelScaleText } = await import('../src/reviewer/scale.js');
    const text = renderLabelScaleText();
    expect(text).toContain(SCALE_GUARD);
    expect(text).toContain('## Risk scale (1..10)');
    expect(text).toContain('## Authorization scale (1..10)');
    // One line per band, so the two numberings cannot share a scale.
    expect(text).toContain('1 an applicable prohibition is in force');
    expect(text).toContain('10 every actual effect fully covered');
  });
});
