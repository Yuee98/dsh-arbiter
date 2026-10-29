/**
 * The proofs that a candidate cannot fork the shared policy.
 *
 * The issue's first acceptance condition asks for fixtures that show the protocol and the
 * common policy did not diverge, and the second forbids an implicit risk gate or a
 * decision tail gate. Both are properties of *rendered bytes*, so they are checked here
 * against real snapshots rather than asserted in a comment.
 *
 * Four claims:
 *
 *   1. every candidate's request starts with the production contract, verbatim — a
 *      variant may add a question and compress the scale, never rewrite the contract;
 *   2. no candidate's prompt contains the matrix, a threshold or a verdict token, so no
 *      variant can introduce a hidden gate by wording;
 *   3. the two scales are the shared ones in every variant: ten bands, the same order,
 *      the same native 0..9 / public 1..10 correspondence;
 *   4. the probe is a question, not a rule: no variant says an irreversible or withdrawn
 *      answer must be denied or escalated.
 */

import { describe, expect, test } from 'vitest';

import {
  AUTHORIZATION_BANDS,
  RISK_BANDS,
  requiredAuthorizationFor,
} from '../src/review-contract/rubrics.js';
import { REVIEW_CONTRACT } from '../src/reviewer/contract.js';
import {
  renderVariantChatRequest,
  renderVariantDecisionRequest,
} from '../src/reviewer/prompt.js';
import { SCALE_GUARD } from '../src/reviewer/scale.js';
import { SCORE_CRITERIA_MAX } from '../src/reviewer/questions.js';
import {
  defineVariant,
  PRODUCTION_VARIANT,
  variantIdFor,
} from '../src/reviewer/variant.js';
import type { ReviewVariant, VariantAxes } from '../src/reviewer/variant.js';
import type { ReviewSnapshot } from '../src/types.js';

/** Every package the committed matrix compares, spelled out. */
const CANDIDATES: readonly {
  readonly id: string;
  readonly axes: VariantAxes;
}[] = [
  {
    id: 'A',
    axes: {
      prompt: 'no-probe',
      structure: 'full',
      history: 'current-turn',
      scale: 'complete',
    },
  },
  {
    id: 'B',
    axes: {
      prompt: 'recovery-probe',
      structure: 'full',
      history: 'current-turn',
      scale: 'complete',
    },
  },
  {
    id: 'C1',
    axes: {
      prompt: 'no-probe',
      structure: 'compact',
      history: 'current-turn',
      scale: 'complete',
    },
  },
  {
    id: 'C2',
    axes: {
      prompt: 'no-probe',
      structure: 'compact-no-audit',
      history: 'current-turn',
      scale: 'complete',
    },
  },
  {
    id: 'C3',
    axes: {
      prompt: 'no-probe',
      structure: 'compact-no-audit',
      history: 'none',
      scale: 'complete',
    },
  },
  {
    id: 'C4',
    axes: {
      prompt: 'no-probe',
      structure: 'compact-no-audit',
      history: 'current-turn',
      scale: 'labels',
    },
  },
];

const CANDIDATE_VARIANTS: readonly ReviewVariant[] = CANDIDATES.map((entry) =>
  defineVariant(entry.axes),
);

/** A snapshot with the material a summary case would carry. */
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
  action: {
    name: 'bash',
    arguments: { command: 'rsync -a logs/ host:/backup' },
  },
  facts: null,
  hint: 'the user asked to keep a copy',
  projectRules: 'PROJECT: never upload credentials',
  customRules: 'CUSTOM: prefer rsync',
  materials: [
    {
      id: 'project-rules',
      enabled: true,
      present: true,
      chars: 30,
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
      text: 'keep a local copy of the logs',
      turn: 4,
    },
  ],
  evidenceTruncated: false,
  parentAuthorizationPresent: false,
  context: [{ ts: 1, tool: 'bash', arguments: '{"command":"ls logs"}' }],
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

/** The chat rendering of one variant. */
function chatOf(variant: ReviewVariant): ChatShape {
  return renderVariantChatRequest(SNAPSHOT, variant);
}

/** The two halves of a chat request, named so a test can read either. */
type ChatShape = ReturnType<typeof renderVariantChatRequest>;

describe('every candidate carries the same contract', () => {
  test('the production contract is the prefix of every chat package', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      expect(chatOf(variant).system.startsWith(REVIEW_CONTRACT)).toBe(true);
    }
  });

  test('the production contract is the prefix of every decision package', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const request = renderVariantDecisionRequest(SNAPSHOT, variant);
      expect(request.state.startsWith(REVIEW_CONTRACT)).toBe(true);
    }
  });

  test('a basis variant submits the production bytes, not a paraphrase', () => {
    const a = chatOf(defineVariant(CANDIDATES[0]?.axes ?? PRODUCTION_VARIANT));
    const production = renderVariantChatRequest(SNAPSHOT, PRODUCTION_VARIANT);
    expect(a.system).toBe(production.system);
    expect(a.user).toBe(production.user);
  });
});

describe('no candidate can carry a hidden gate', () => {
  test('no prompt states a matrix threshold or a verdict token', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const { system, user } = chatOf(variant);
      for (const text of [system, user]) {
        expect(text).not.toContain('requiredAuthorization');
        expect(text).not.toContain('review-deny');
        expect(text).not.toContain('review-allow');
        expect(text).not.toContain('force-ask');
        // Band names never appear as literal gate values.
        expect(text).not.toMatch(/\bA(?:8|9|10)\b/u);
        expect(text).not.toContain('tau');
      }
    }
  });

  test('the matrix is not printed anywhere', () => {
    // A printed matrix would let the model reason about the answer key; it would also be
    // the shortest path to a variant that quietly grades to a threshold. The bands do
    // appear as a scale, so this checks the mapping phrase and the verdict tokens rather
    // than the digits.
    expect(requiredAuthorizationFor(2)).toBe(2);
    for (const variant of CANDIDATE_VARIANTS) {
      const { system } = chatOf(variant);
      expect(system).not.toContain('required authorization');
      expect(system).not.toContain('requiredAuthorizationFor');
    }
  });

  test('no candidate turns an irreversible or withdrawn answer into a denial', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const { system } = chatOf(variant);
      for (const pattern of [
        /irreversible[^.]*\b(?:deny|denied|reject|rejected)\b/iu,
        /irreversible[^.]*\b(?:escalate|human)\b/iu,
        /withdrawn[^.]*\b(?:force|always)\b[^.]*\b(?:ask|human)\b/iu,
      ]) {
        expect(pattern.test(system)).toBe(false);
      }
    }
  });

  test('the probe adds a question and an answer member, never a rule', () => {
    const b = defineVariant(CANDIDATES[1]?.axes ?? PRODUCTION_VARIANT);
    const { system } = chatOf(b);
    // The probe's options are answers; any statement about what to do with one is the
    // implementation inventing a product rule.
    expect(system).not.toMatch(/must be denied/iu);
    expect(system).not.toMatch(/automatically escalate/iu);
    expect(system).toContain('beside the two bands');
  });
});

describe('the scales do not diverge between candidates', () => {
  test('every chat package prints ten risk and ten authorization bands', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const { system } = chatOf(variant);
      for (const band of RISK_BANDS) {
        expect(system).toContain(`${String(band.score)} `);
      }
      expect(system).toContain('## Risk scale (1..10)');
      expect(system).toContain('## Authorization scale (1..10)');
      // Ten lines per scale, whatever the variant: compression shortens each line, it
      // never drops a band.
      const riskLines = system
        .split('## Risk scale (1..10)')[1]
        ?.split('## Authorization scale')[0]
        ?.split('\n')
        .filter((line) => /^\d+ /u.test(line));
      expect(riskLines).toHaveLength(10);
      const authLines = system
        .split('## Authorization scale (1..10)')[1]
        ?.split(SCALE_GUARD)[0]
        ?.split('\n')
        .filter((line) => /^\d+ /u.test(line));
      expect(authLines).toHaveLength(10);
    }
  });

  test('every decision package asks exactly two score questions of ten criteria', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const request = renderVariantDecisionRequest(SNAPSHOT, variant);
      // Exactly two questions carry a criterion list; the probe, when present, is the
      // one other question and it carries no criteria at all.
      const scoreQuestions = [
        request.questions.risk,
        request.questions.authorization,
      ];
      expect(scoreQuestions.map((question) => question.type)).toEqual([
        'score',
        'score',
      ]);
      for (const question of scoreQuestions) {
        expect(question.type).toBe('score');
        expect(question.criteria).toHaveLength(SCORE_CRITERIA_MAX);
      }
      // The probe question is present exactly for the package that asks it, and it is
      // never a third scored question.
      const probeType = request.questions.recoverability?.type ?? 'absent';
      expect(probeType).toBe(
        variant.prompt === 'recovery-probe' ? 'choice' : 'absent',
      );
    }
  });

  test('the native numbering stays 0..9 in every variant', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const request = renderVariantDecisionRequest(SNAPSHOT, variant);
      const criteria = request.questions.risk.criteria;
      expect(criteria[0]?.startsWith('0 ')).toBe(true);
      expect(criteria[9]?.startsWith('9 ')).toBe(true);
    }
  });

  test('the band set is the shared one, in the shared order', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const request = renderVariantDecisionRequest(SNAPSHOT, variant);
      const authorization = request.questions.authorization.criteria;
      // Each native line carries that band's own complete operational definition
      // (`rubric-text.ts`), not the terse one-line label, and the label is what the
      // compressed variant prints — so the two are distinct texts over one band set.
      expect(authorization).toHaveLength(AUTHORIZATION_BANDS.length);
      // The complete text, not the terse label: the two are different tables over one
      // band set, and only the compressed variant prints the label.
      AUTHORIZATION_BANDS.forEach((band, index) => {
        expect(authorization[index]?.startsWith(`${String(index)} `)).toBe(
          true,
        );
        expect(authorization[index]?.length).toBeGreaterThan(
          band.criterion.length,
        );
      });
    }
  });

  test('a compressed scale keeps the guard and still prints every band', () => {
    const c4 = defineVariant(CANDIDATES[5]?.axes ?? PRODUCTION_VARIANT);
    const { system } = chatOf(c4);
    expect(system).toContain(SCALE_GUARD);
    for (const band of AUTHORIZATION_BANDS) {
      expect(system).toContain(band.criterion);
    }
  });
});

describe('the material a candidate judges is the same', () => {
  test('a layout change never drops the action, the authorization or the gaps', () => {
    for (const variant of CANDIDATE_VARIANTS) {
      const { user } = chatOf(variant);
      // Every layout must still say what would run and what the user allowed.
      expect(user).toContain('rsync -a logs/ host:/backup');
      expect(user).toContain('keep a local copy of the logs');
      expect(user).toContain('never upload credentials');
      expect(user).toMatch(/blocking_gaps|material_completeness/);
    }
  });

  test('the history ablation says it withheld history rather than implying an empty turn', () => {
    const c3 = defineVariant(CANDIDATES[4]?.axes ?? PRODUCTION_VARIANT);
    const { user } = chatOf(c3);
    expect(user).toContain('withheld');
    expect(user).toContain('not evidence that no call happened');
    // The authorization items are a different block and are never withheld with it.
    expect(user).toContain('keep a local copy of the logs');
  });

  test('a full-layout candidate still carries the turn history', () => {
    const a = defineVariant(CANDIDATES[0]?.axes ?? PRODUCTION_VARIANT);
    const { user } = chatOf(a);
    expect(user).toContain('TURN_TOOL_HISTORY');
    expect(user).toContain('ls logs');
  });

  test('the identity of each candidate is distinct', () => {
    const ids = CANDIDATE_VARIANTS.map((variant) => variantIdFor(variant));
    expect(new Set(ids).size).toBe(ids.length);
  });
});
