import { describe, expect, test } from 'vitest';

import {
  AUTHORIZATION_BANDS,
  RISK_BANDS,
} from '../src/review-contract/rubrics.js';
import {
  buildQuestions,
  SCORE_CRITERIA_MAX,
} from '../src/reviewer/questions.js';
import {
  CHAT_PROTOCOL,
  DECISION_PROTOCOL,
  REVIEW_CONTRACT,
  REVIEW_PROMPT_VERSION,
  scaleText,
} from '../src/reviewer/contract.js';
import {
  renderChatRequest,
  renderChatSystem,
  renderChatUser,
  renderDecisionRequest,
  renderDecisionState,
} from '../src/reviewer/prompt.js';
import type { ReviewSnapshot } from '../src/types.js';

/**
 * The fixed prompt and the two request envelopes.
 *
 * These cases pin the parts a model's behaviour depends on and a cache layout
 * could tempt someone to reorder: the contract is the stable prefix, the material
 * order is fixed, and the two protocols number the same ten bands differently
 * without either of them advertising the other's numbering.
 */

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
  context: [],
  checkpoints: [],
  contextTruncated: false,
  priorVerdicts: [],
  historyTruncated: false,
  historyStatus: {
    coverage: 'known-empty',
    windowTruncated: false,
    reason: null,
    sources: {
      memory: { read: 0, unavailable: null },
      session: { read: 0, unavailable: null },
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

/** The block labels in submission order. */
const MATERIAL_ORDER = [
  'ENVIRONMENT',
  'POLICY_AND_GUIDANCE',
  'HUMAN_AUTHORIZATION',
  'TURN_TOOL_HISTORY',
  'PRIOR_VERDICTS',
  'PENDING_ACTION',
  'ACTION_FACTS',
  'MATERIAL_COMPLETENESS',
];

describe('the fixed contract', () => {
  test('is the prefix of both protocols and names no matrix or threshold', () => {
    const system = renderChatSystem();
    const decision = renderDecisionState('MATERIAL');
    for (const text of [system, decision]) {
      expect(text.startsWith(REVIEW_CONTRACT)).toBe(true);
      // The engine owns the matrix. Handing it to the model would ask it to reason
      // about the answer key, which is not the authority this review depends on.
      expect(text).not.toContain('requiredAuthorization');
      expect(text).not.toContain('tau');
      expect(text).not.toContain('review-allow');
      expect(text).not.toContain('review-deny');
      expect(text).not.toContain('A8');
      expect(text).not.toContain('A9');
    }
  });

  test('states the source ladder and that permission raises no ceiling', () => {
    const system = renderChatSystem();
    // The ladder, in priority order, as one run of text.
    expect(system).toContain('this session');
    expect(system).toContain('direct parent session');
    expect(system).toContain('PROJECT_RULES');
    expect(system).toContain('CUSTOM_RULES');
    expect(system).toContain('agent relay');
    // A full delegation or standing policy may reach the top band.
    expect(system).toContain('reach the highest band');
    // A hint is not permission.
    expect(system).toContain('never creates permission');
  });

  test('states that truncation and absence are input facts', () => {
    const system = renderChatSystem();
    expect(system).toContain('input fact, not a finding');
    expect(system).toContain('neither danger nor authorization');
  });

  test('carries a version so a stored attempt names the semantics it used', () => {
    expect(REVIEW_PROMPT_VERSION).toBe('review-prompt-v1');
    // The two wire names are distinct and versioned with the semantics they read.
    expect(CHAT_PROTOCOL).toBe('arbiter-chat-json-v2');
    expect(DECISION_PROTOCOL).toBe('arbiter-decision-v2');
    expect(CHAT_PROTOCOL).not.toBe(DECISION_PROTOCOL);
  });
});

describe('the chat numbering', () => {
  test('prints all ten risk bands and all ten authorization bands as 1..10', () => {
    const system = renderChatSystem();
    for (let score = 1; score <= 10; score += 1) {
      const risk = RISK_BANDS[score - 1];
      const auth = AUTHORIZATION_BANDS[score - 1];
      if (risk === undefined || auth === undefined) {
        throw new Error('missing band');
      }
      expect(system).toContain(`${String(score)} ${risk.criterion}`);
      expect(system).toContain(`${String(score)} ${auth.criterion}`);
      // A chat answer is public, so the native 0..9 spelling must not appear in
      // its scale block: two numberings in one request ask which one is meant.
      expect(scaleText()).not.toContain(`${String(score)} 0 `);
    }
    // The scale block is exactly the ten bands of each, no more.
    const scale = scaleText();
    for (const band of [...RISK_BANDS, ...AUTHORIZATION_BANDS]) {
      expect(scale).toContain(band.criterion);
    }
  });

  test('asks for exactly two integers and no probes', () => {
    const system = renderChatSystem();
    expect(system).toContain(
      '{"risk":<integer 1-10>,"authorization":<integer 1-10>}',
    );
    for (const probe of ['secrets', 'destructive', 'egress', 'bulk']) {
      expect(system).not.toContain(probe);
    }
  });
});

describe('the decision questions', () => {
  test('carry exactly ten criteria per score, numbered from zero', () => {
    const questions = buildQuestions();
    const built = Object.values(questions);
    expect(built).toHaveLength(2);
    const risk = questions.risk;
    const authorization = questions.authorization;
    expect(risk.criteria).toHaveLength(SCORE_CRITERIA_MAX);
    expect(authorization.criteria).toHaveLength(SCORE_CRITERIA_MAX);
    // Native numbering: the highest criterion is 9, not 10.
    expect(risk.criteria[0]).toBe(`0 ${RISK_BANDS[0]?.criterion ?? ''}`);
    expect(risk.criteria[9]).toBe(`9 ${RISK_BANDS[9]?.criterion ?? ''}`);
    expect(authorization.criteria[0]).toBe(
      `0 ${AUTHORIZATION_BANDS[0]?.criterion ?? ''}`,
    );
  });

  test('are built from the same bands the chat scale prints', () => {
    const questions = buildQuestions();
    // Both protocols advertise the same ten bands; only the numbering differs, so
    // every criterion text appears in both forms.
    for (const [index, band] of RISK_BANDS.entries()) {
      expect(questions.risk.criteria[index]).toBe(
        `${String(index)} ${band.criterion}`,
      );
      expect(scaleText()).toContain(`${String(band.score)} ${band.criterion}`);
    }
    for (const [index, band] of AUTHORIZATION_BANDS.entries()) {
      expect(questions.authorization.criteria[index]).toBe(
        `${String(index)} ${band.criterion}`,
      );
      expect(scaleText()).toContain(`${String(band.score)} ${band.criterion}`);
    }
  });

  test('are not the old eleven-band list with the top band cut off', () => {
    const questions = buildQuestions();
    // The retired list's own wording must be gone: a scale rebuilt from the rubric
    // describes consequences, and the old per-command legend does not.
    const serialized = JSON.stringify(questions);
    expect(serialized).not.toContain('push a branch to a remote');
    expect(serialized).not.toContain('no side effects');
    expect(serialized).not.toContain('no evidence at all');
    expect(serialized).not.toContain('mass irreversible delete');
  });

  test('ask no boolean probe question', () => {
    const questions = buildQuestions();
    expect(Object.keys(questions)).toEqual(['risk', 'authorization']);
    // Both questions are `score` answers: a boolean fact has no question to
    // answer, because a consequence that matters raises the risk band and a
    // permission that does not cover the action lowers the authorization band.
    expect(questions.risk.type).toBe('score');
    expect(questions.authorization.type).toBe('score');
  });

  test('the state names the native direction without printing a second scale', () => {
    const state = renderDecisionState('MATERIAL');
    expect(state).toContain('numbered from 0');
    expect(state).toContain('criterion 9 is the highest');
    // The chat wording for the same bands is absent: a native endpoint reads the
    // criteria list itself, and the two numberings would collide.
    expect(state).not.toContain('## Risk scale (1..10)');
    expect(state).not.toContain('## Authorization scale (1..10)');
  });
});

describe('the material order', () => {
  test('emits the stable blocks in one fixed order', () => {
    const user = renderChatUser(SNAPSHOT);
    // Each label is a block header: it starts a line and is followed by one, so a
    // mention inside prose cannot be mistaken for the block itself.
    const positions = MATERIAL_ORDER.map((label) => {
      const at = user.search(new RegExp(`(?:^|\\n\\n)${label}\\n`, 'u'));
      expect(at).toBeGreaterThan(-1);
      return at;
    });
    const sorted = [...positions].sort((left, right) => left - right);
    expect(positions).toEqual(sorted);
  });

  test('places the semantic material before the action', () => {
    const user = renderChatUser(SNAPSHOT);
    const action = user.indexOf('PENDING_ACTION');
    for (const label of [
      'ENVIRONMENT',
      'POLICY_AND_GUIDANCE',
      'HUMAN_AUTHORIZATION',
      'TURN_TOOL_HISTORY',
      'PRIOR_VERDICTS',
    ]) {
      expect(user.indexOf(label)).toBeLessThan(action);
    }
    // The completeness report follows the action: it describes the submission the
    // action arrived in.
    expect(user.indexOf('MATERIAL_COMPLETENESS')).toBeGreaterThan(action);
  });

  test('serializes identically for the same snapshot', () => {
    expect(renderChatUser(SNAPSHOT)).toBe(renderChatUser(SNAPSHOT));
    expect(renderChatRequest(SNAPSHOT).user).toBe(renderChatUser(SNAPSHOT));
    // The clock is not material: a different build time must render the same.
    expect(renderChatUser({ ...SNAPSHOT, createdAt: 999 })).toBe(
      renderChatUser(SNAPSHOT),
    );
  });

  test('keeps the labelled guidance in the payload, never in the system text', () => {
    const request = renderChatRequest(SNAPSHOT);
    // System carries the contract and the scale only; user material stays user.
    expect(request.system).not.toContain('never touch /etc');
    expect(request.system).not.toContain('prefer pnpm');
    expect(request.user).toContain('never touch /etc');
    expect(request.user).toContain('prefer pnpm');
    expect(request.user).toContain('PROJECT_RULES');
    expect(request.user).toContain('CUSTOM_RULES');
    // The order sentence states which wins, and it is the wire contract's rule.
    expect(request.user).toContain('PROJECT_RULES wins');
  });

  test('reports an empty guidance source as known-empty rather than missing', () => {
    const user = renderChatUser({
      ...SNAPSHOT,
      projectRules: null,
      customRules: '',
      materials: [],
    });
    expect(user).toContain('PROJECT_RULES\n(none)');
    expect(user).toContain('CUSTOM_RULES\n(none)');
    expect(user).toContain('"project_rules_enabled": false');
  });

  test('a hint travels after the action, never inside the contract', () => {
    const request = renderChatRequest(SNAPSHOT);
    expect(request.user.indexOf('REVIEW_HINT')).toBeGreaterThan(
      request.user.indexOf('PENDING_ACTION'),
    );
    expect(request.system).not.toContain(SNAPSHOT.hint ?? '');
  });

  test('states a blocking gap without turning it into a finding', () => {
    const user = renderChatUser({
      ...SNAPSHOT,
      completeness: {
        status: 'insufficient',
        items: [],
        gaps: [{ source: 'session-log', reason: 'the log could not be read' }],
        note: 'session log unreadable',
      },
      missing: ['the session log could not be read'],
    });
    expect(user).toContain('"status": "insufficient"');
    expect(user).toContain('session-log');
    expect(user).toContain('not findings');
  });
});

describe('the decision request', () => {
  test('submits the same material as chat, under the same contract', () => {
    const material = renderChatUser(SNAPSHOT);
    const decision = renderDecisionRequest(material);
    expect(decision.state).toContain(REVIEW_CONTRACT);
    expect(decision.state).toContain(material);
    // One composition, not two: the decision state embeds the chat payload.
    expect(decision.state.endsWith(material)).toBe(true);
  });

  test('estimates both halves of what it sends', () => {
    const decision = renderDecisionRequest(renderChatUser(SNAPSHOT));
    expect(decision.estimatedInputTokens).toBeGreaterThan(0);
    // The questions are part of the payload, so the estimate must grow with them.
    const stateOnly = renderDecisionState(renderChatUser(SNAPSHOT));
    expect(decision.estimatedInputTokens).toBeGreaterThan(
      stateOnly.length / 100,
    );
  });
});
