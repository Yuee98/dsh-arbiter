/**
 * The run artifact: shapes, identity and the offline consumer path.
 *
 * The claim this file pins is the one a report depends on: a run directory written by
 * this runner can be read back without a model, without a socket and without importing
 * the executor. So every assertion here reads files the runner wrote, through the
 * published schemas, and compares what came back with what the plan said it would be.
 *
 * Three distinctions get their own tests because getting them wrong would silently
 * change what a report says:
 *
 *   - an unsupported model/protocol pairing is decided from the plan, never from a
 *     response, so it cannot be filled with a made-up answer;
 *   - unknown usage stays null and an explicitly reported zero stays zero;
 *   - cost is a status, never a number, because a zero would read as a free call.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
  cellIdOf as identityOf,
  cellSucceeded,
  planDigest,
  readFixture,
  readRun,
  recordPathOf,
  RUN_FILES,
  scoredOutcome,
  usageAttemptsOf,
} from '../../evals/src/run/artifact.js';
import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import { cellGrid, planProblems } from '../../evals/src/run/plan.js';
import {
  RUN_FIXTURE_VERSION,
  RUN_PLAN_VERSION,
} from '../../evals/src/run/types.js';
import type { CellRecord } from '../../evals/src/run/types.js';
import {
  bounds,
  cellIdOf,
  chatAnswer,
  chatTarget,
  decisionTarget,
  dualTarget,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

const runCheckers = await compileRunCheckers();
const checkers = runCheckers;

describe('run plan schema', () => {
  it('accepts a plan whose offline transport names a fixture', () => {
    const checked = checkers.plan(planOf());
    expect(checked.ok).toBe(true);
  });

  it('refuses an offline plan with no fixture', () => {
    // Replaying nothing is not the same as replaying a refusal, so a plan that would
    // have no script cannot be accepted as a plan.
    const checked = checkers.plan(planOf({ fixture: null }));
    expect(checked.ok).toBe(false);
  });

  it('refuses a live plan that carries a fixture', () => {
    const checked = checkers.plan(
      planOf({ transport: 'live', fixture: 'fixture.json' }),
    );
    expect(checked.ok).toBe(false);
  });

  it('refuses a plan with no protocol or no target', () => {
    expect(checkers.plan(planOf({ protocols: [] })).ok).toBe(false);
    expect(checkers.plan(planOf({ targets: [] })).ok).toBe(false);
  });

  it('refuses a concurrency bound above the runner maximum', () => {
    expect(
      checkers.plan(planOf({ bounds: bounds({ concurrency: 64 }) })).ok,
    ).toBe(false);
  });

  it('refuses a plan whose target names both protocols and a section it cannot use', () => {
    // A target's own protocol sections are what decide support; an extra member would
    // imply a third shape nobody reads.
    const leaked = {
      ...planOf(),
      targets: [{ ...chatTarget(), extra: true }],
    };
    expect(checkers.plan(leaked).ok).toBe(false);
  });
});

describe('plan expansion', () => {
  it('produces one cell per case, target, protocol and repeat', () => {
    const plan = planOf({
      caseIds: ['a', 'b'],
      protocols: ['chat', 'decision'],
      targets: [dualTarget()],
      repeats: 2,
    });
    const grid = cellGrid(plan);
    // 2 cases x 1 target x 2 protocols x 2 repeats
    expect(grid.cells).toHaveLength(8);
    expect(grid.supported).toBe(8);
    expect(grid.unsupported).toBe(0);
  });

  it('marks a protocol a target does not offer as unsupported, not as a missing cell', () => {
    const plan = planOf({
      caseIds: ['a'],
      protocols: ['chat', 'decision'],
      targets: [chatTarget()],
    });
    const grid = cellGrid(plan);
    const decision = grid.cells.filter((cell) => cell.protocol === 'decision');
    expect(decision).toHaveLength(1);
    expect(decision[0]?.supported).toBe(false);
    expect(decision[0]?.unsupportedReason).toContain(
      'does not offer protocol decision',
    );
    expect(grid.unsupported).toBe(1);
    expect(grid.supported).toBe(1);
  });

  it('gives an independent repeat its own identity', () => {
    const once = cellIdOf({ caseId: 'a', targetId: 't', protocol: 'chat' });
    const twice = cellIdOf({
      caseId: 'a',
      targetId: 't',
      protocol: 'chat',
      repeat: 2,
    });
    expect(once).not.toBe(twice);
    // The declared helper and the module's own rule must be the same rule, or two
    // tools would locate different records for one cell.
    expect(once).toBe(
      identityOf({ caseId: 'a', targetId: 't', protocol: 'chat', repeat: 1 }),
    );
  });

  it('is deterministic: the same plan expands to the same order twice', () => {
    const plan = planOf({ caseIds: ['a', 'b'], repeats: 2 });
    expect(cellGrid(plan).cells.map((cell) => cell.cellId)).toEqual(
      cellGrid(plan).cells.map((cell) => cell.cellId),
    );
  });

  it('reports a target that supports nothing as a plan problem', () => {
    const target = { ...chatTarget(), chat: null, decision: null };
    expect(planProblems(planOf({ targets: [target] }))).toContain(
      'target chat-a supports neither protocol; omit it or name what it supports',
    );
  });

  it('reports a protocol no target offers instead of silently running nothing', () => {
    expect(
      planProblems(
        planOf({ protocols: ['chat', 'decision'], targets: [chatTarget()] }),
      ).some((problem) =>
        problem.includes('no target supports protocol decision'),
      ),
    ).toBe(true);
  });

  it('reports a duplicate target id', () => {
    expect(
      planProblems(
        planOf({ targets: [chatTarget('a'), chatTarget('a')] }),
      ).some((problem) => problem.includes('declared twice')),
    ).toBe(true);
  });
});

describe('run document schema', () => {
  it('accepts an index whose versions name the runtime', () => {
    const plan = planOf();
    const created = checkers.index({
      documentVersion: 'eval-run-index-v1',
      runId: 'core-v1-abc',
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      status: 'running',
      plan,
      planHash: 'sha256:' + '0'.repeat(64),
      dataset: {
        datasetId: 'core-v1',
        digest: 'sha256:' + '1'.repeat(64),
        caseCount: 1,
        caseIds: ['read-named-source-file'],
      },
      versions: {
        contract: 'c',
        prompt: 'p',
        usageMapping: 'u',
        plan: RUN_PLAN_VERSION,
        artifact: 'eval-run-artifact-v1',
        implementation: 'i',
        node: '24.0.0',
      },
      transport: 'offline',
      bounds: bounds(),
      spent: {
        cellsStarted: 0,
        cellsCompleted: 0,
        cellsPlanned: 1,
        attempts: 0,
        estimatedInputTokens: 0,
        reportedOutputTokens: null,
      },
      cells: [],
      resumed: [],
      notes: [],
    });
    expect(created.ok).toBe(true);
  });

  it('refuses an index that omits the runtime version', () => {
    const created = checkers.index({
      documentVersion: 'eval-run-index-v1',
      runId: 'core-v1-abc',
      createdAt: '2026-10-29T00:00:00.000Z',
      updatedAt: '2026-10-29T00:00:00.000Z',
      status: 'running',
      plan: planOf(),
      planHash: 'sha256:' + '0'.repeat(64),
      dataset: {
        datasetId: 'core-v1',
        digest: 'sha256:' + '1'.repeat(64),
        caseCount: 0,
        caseIds: [],
      },
      versions: {
        contract: 'c',
        prompt: 'p',
        usageMapping: 'u',
        plan: RUN_PLAN_VERSION,
        artifact: 'eval-run-artifact-v1',
        implementation: 'i',
      },
      transport: 'offline',
      bounds: bounds(),
      spent: {
        cellsStarted: 0,
        cellsCompleted: 0,
        cellsPlanned: 0,
        attempts: 0,
        estimatedInputTokens: 0,
        reportedOutputTokens: null,
      },
      cells: [],
      resumed: [],
      notes: [],
    });
    // The node version is recorded because a runtime change can change token
    // estimation, so a run that did not record it cannot be compared with one that did.
    expect(created.ok).toBe(false);
  });

  it('refuses a record whose usage bucket is a string', () => {
    const broken = {
      ...minimalRecord(),
      attempts: [
        {
          ...minimalRecord().attempts[0],
          normalizedUsage: {
            ...minimalRecord().attempts[0]?.normalizedUsage,
            tokens: {
              ...minimalRecord().attempts[0]?.normalizedUsage.tokens,
              inputTokens: '12',
            },
          },
        },
      ],
    };
    expect(checkers.record(broken).ok).toBe(false);
  });

  it('accepts a record that reports null usage and a null outcome', () => {
    const record = {
      ...minimalRecord(),
      status: 'unsupported',
      outcome: null,
      attempts: [],
      usage: null,
      cost: {
        status: 'not-applicable',
        amount: null,
        currency: null,
        reason: 'no model call was made for this cell',
      },
      material: null,
    };
    expect(checkers.record(record).ok).toBe(true);
  });

  it('refuses a record whose cost carries a number', () => {
    const record = {
      ...minimalRecord(),
      cost: {
        status: 'not-computed',
        amount: 0,
        currency: null,
        reason: 'r',
      },
    };
    // A number here would read as a real price, and this runner does not price tokens.
    expect(checkers.record(record).ok).toBe(false);
  });

  it('refuses a fixture whose chat entry is a decision script', () => {
    // The two protocols' scripts are different shapes, and a fixture that crossed them
    // would let a cell replay a stream its transport could never read.
    const crossed = {
      fixtureVersion: 'eval-offline-fixture-v1',
      description: 'd',
      cells: { cell: { chat: [{ status: 200, body: '{}' }], decision: null } },
      notes: [],
    };
    expect(checkers.fixture(crossed).ok).toBe(false);
  });
});

describe('reading a run directory', () => {
  it('reports an absent plan and an absent index by the file that is missing', async () => {
    await withArea(async (area) => {
      const read = await readRun(area.path, checkers);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problems.map((problem) => problem.path)).toEqual([
        RUN_FILES.plan,
        RUN_FILES.index,
      ]);
    });
  });

  it('reports a cell whose record was planned but never written', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write(RUN_FILES.plan, plan);
      await area.write(RUN_FILES.index, {
        documentVersion: 'eval-run-index-v1',
        runId: 'run-1',
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
        status: 'running',
        plan,
        planHash: planDigest(plan),
        dataset: {
          datasetId: 'core-v1',
          digest: 'sha256:' + '0'.repeat(64),
          caseCount: 1,
          caseIds: plan.caseIds,
        },
        versions: versionsWithNode(),
        transport: 'offline',
        bounds: plan.bounds,
        spent: {
          cellsStarted: 0,
          cellsCompleted: 0,
          cellsPlanned: 1,
          attempts: 0,
          estimatedInputTokens: 0,
          reportedOutputTokens: null,
        },
        cells: [
          {
            cellId,
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 1,
            record: recordPathOf(cellId),
            status: 'not-run',
            attempts: 0,
            stopReason: null,
          },
        ],
        resumed: [],
        notes: [],
      });
      const read = await readRun(area.path, checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      // An interrupted run is a normal state, so a planned cell with no record is
      // reported as missing rather than as a corrupt directory.
      expect(read.artifact.missing.map((cell) => cell.cellId)).toEqual([
        cellId,
      ]);
      expect(read.artifact.records).toEqual([]);
    });
  });

  it('reports a record file that does not match its schema by name', async () => {
    await withArea(async (area) => {
      const plan = planOf();
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'chat-a',
        protocol: 'chat',
      });
      await area.write(RUN_FILES.plan, plan);
      await area.write(RUN_FILES.index, {
        documentVersion: 'eval-run-index-v1',
        runId: 'run-1',
        createdAt: '2026-10-29T00:00:00.000Z',
        updatedAt: '2026-10-29T00:00:00.000Z',
        status: 'running',
        plan,
        planHash: planDigest(plan),
        dataset: {
          datasetId: 'core-v1',
          digest: 'sha256:' + '0'.repeat(64),
          caseCount: 1,
          caseIds: plan.caseIds,
        },
        versions: versionsWithNode(),
        transport: 'offline',
        bounds: plan.bounds,
        spent: {
          cellsStarted: 0,
          cellsCompleted: 0,
          cellsPlanned: 1,
          attempts: 0,
          estimatedInputTokens: 0,
          reportedOutputTokens: null,
        },
        cells: [
          {
            cellId,
            caseId: 'read-named-source-file',
            targetId: 'chat-a',
            protocol: 'chat',
            repeat: 1,
            record: recordPathOf(cellId),
            status: 'not-run',
            attempts: 0,
            stopReason: null,
          },
        ],
        resumed: [],
        notes: [],
      });
      await area.write(recordPathOf(cellId), { documentVersion: 'wrong' });
      const read = await readRun(area.path, checkers);
      expect(read.ok).toBe(false);
      if (read.ok) return;
      expect(read.problems[0]?.path).toBe(recordPathOf(cellId));
    });
  });
});

describe('fixture reading', () => {
  it('refuses a fixture of the wrong version', async () => {
    await withArea(async (area) => {
      await area.write('fixture.json', {
        fixtureVersion: 'eval-offline-fixture-v0',
        description: 'd',
        cells: {},
        notes: [],
      });
      const read = await readFixture(join(area.path, 'fixture.json'), checkers);
      expect(read.ok).toBe(false);
    });
  });

  it('reads a fixture keyed by cell id', async () => {
    await withArea(async (area) => {
      const fixture = fixtureOf({
        'a~t~chat~r1': fixtureCell({ chat: [chatAnswer(5, 9)] }),
      });
      await area.write('fixture.json', fixture);
      const read = await readFixture(join(area.path, 'fixture.json'), checkers);
      expect(read.ok).toBe(true);
      if (!read.ok) return;
      expect(read.fixture.fixtureVersion).toBe(RUN_FIXTURE_VERSION);
      expect(Object.keys(read.fixture.cells)).toEqual(['a~t~chat~r1']);
    });
  });
});

describe('consumer helpers', () => {
  it('reports a scored outcome and a reviewed cell for a successful review', () => {
    const record = recordWithScore(5, 9);
    expect(cellSucceeded(record)).toBe(true);
    expect(scoredOutcome(record)?.risk).toBe(5);
  });

  it('reports no scored outcome for a failure even when the cell ran', () => {
    const record = {
      ...recordWithScore(5, 9),
      outcome: {
        status: 'review-failure' as const,
        failures: [],
        reason: 'the reviewer produced no answer',
        diagnostic: null,
      },
    };
    expect(cellSucceeded(record)).toBe(true);
    // A failure stays a failure: no score is derived from a diagnostic.
    expect(scoredOutcome(record)).toBeNull();
  });

  it('exposes the attempts in the shape the shared aggregate takes', () => {
    const record = recordWithScore(5, 9);
    expect(usageAttemptsOf(record).map((entry) => entry.attemptId)).toEqual([
      'a~t~chat~r1:model:1',
    ]);
  });

  it('keeps a decision target out of a chat target', () => {
    expect(chatTarget().decision).toBeNull();
    expect(decisionTarget().chat).toBeNull();
    expect(dualTarget().chat).not.toBeNull();
    expect(dualTarget().decision).not.toBeNull();
  });
});

describe('the committed schemas', () => {
  it('publishes the run documents in the schema directory', async () => {
    for (const name of [
      'run.schema.json',
      'run-record.schema.json',
      'run-plan.schema.json',
      'run-fixture.schema.json',
      'run-common.schema.json',
    ]) {
      const document: unknown = JSON.parse(
        await readFile(join('evals/schemas', name), 'utf8'),
      );
      expect(document).toBeTruthy();
    }
  });
});

/** The versions one record carries, with the runtime omitted as a record does. */
function versionsWithNode() {
  return {
    contract: 'c',
    prompt: 'p',
    usageMapping: 'u',
    plan: RUN_PLAN_VERSION,
    artifact: 'eval-run-artifact-v1',
    implementation: 'i',
    node: '24.0.0',
  };
}

/** The simplest record that passes its schema, for a test to vary one member of. */
function minimalRecord() {
  const tokens = {
    inputTokens: 12,
    outputTokens: 4,
    totalTokens: 16,
    cacheReadTokens: null,
    cacheWriteTokens: null,
    reasoningTokens: 0,
  };
  const inclusions = {
    cacheRead: 'unknown',
    cacheWrite: 'unknown',
    reasoning: 'separate',
  };
  return {
    documentVersion: 'eval-cell-record-v1',
    runId: 'run-1',
    cellId: 'a~t~chat~r1',
    createdAt: '2026-10-29T00:00:00.000Z',
    case: {
      caseId: 'a',
      familyId: 'f',
      split: 'dev',
      provenanceSource: 'synthetic',
      inputHash: 'sha256:' + '0'.repeat(64),
    },
    execution: { origin: 'original', repeat: 1, transport: 'offline' },
    entryPoint: {
      kind: 'direct-service',
      materialChain: 'case-input',
      detail: 'd',
    },
    target: {
      targetId: 't',
      provider: 'p',
      configuredModel: 'm',
      modelVersion: null,
      protocol: 'chat',
      protocolName: 'arbiter-chat-json-v2',
      responseModel: null,
      costTier: 'unknown',
    },
    material: {
      inputHash: 'sha256:' + '0'.repeat(64),
      promptFingerprint: 'sha256:' + '1'.repeat(64),
      estimatedInputTokens: 10,
      maxInputTokens: 100,
      truncatedSegments: [],
      completenessStatus: 'complete',
      blockingGaps: [],
      missing: [],
      notices: [],
    },
    status: 'reviewed',
    stopReason: null,
    outcome: {
      status: 'scored',
      source: 'chat',
      risk: 5,
      authorization: 9,
      requiredAuthorization: 9,
      verdict: 'review-allow',
      audit: {
        risk: { native: null, published: null, point: 5, score: 5 },
        authorization: { native: null, published: null, point: 9, score: 9 },
      },
    },
    attempts: [
      {
        attemptId: 'a~t~chat~r1:model:1',
        callId: 'a~t~chat~r1',
        attempt: 1,
        kind: 'initial',
        backend: 'chat',
        protocol: 'arbiter-chat-json-v2',
        request: { provider: 'p' },
        responseText: '{"risk":5,"authorization":9}',
        parsed: { risk: 5, authorization: 9 },
        error: null,
        failureKind: null,
        startedAt: 0,
        durationMs: 1,
        estimatedInputTokens: 10,
        rawUsage: { input_tokens: 12 },
        normalizedUsage: {
          mappingVersion: 'review-usage-v1',
          source: 'chat',
          tokens,
          inclusions,
          sources: [{ field: 'inputTokens', path: 'input_tokens' }],
          ignored: [],
          raw: { input_tokens: 12 },
        },
      },
    ],
    usage: {
      mappingVersion: 'review-usage-v1',
      attempts: 1,
      withUsage: 1,
      duplicateAttempts: 0,
      totals: {
        inputTokens: { total: 12, reported: 1, missing: 0, complete: true },
        outputTokens: { total: 4, reported: 1, missing: 0, complete: true },
        totalTokens: { total: 16, reported: 1, missing: 0, complete: true },
        cacheReadTokens: {
          total: null,
          reported: 0,
          missing: 1,
          complete: false,
        },
        cacheWriteTokens: {
          total: null,
          reported: 0,
          missing: 1,
          complete: false,
        },
        reasoningTokens: { total: 0, reported: 1, missing: 0, complete: true },
      },
      inclusions,
    },
    cost: {
      status: 'not-computed',
      amount: null,
      currency: null,
      reason: 'r',
    },
    timing: { startedAt: 0, durationMs: 1 },
    versions: {
      contract: 'c',
      prompt: 'p',
      usageMapping: 'u',
      plan: RUN_PLAN_VERSION,
      artifact: 'eval-run-artifact-v1',
      implementation: 'i',
    },
    notes: [],
  };
}

/** A record whose outcome scored a pair, for the consumer-helper tests. */
function recordWithScore(risk: number, authorization: number): CellRecord {
  const base = minimalRecord();
  const checkers = runCheckers;
  const checked = checkers.record({
    ...base,
    outcome: {
      status: 'scored' as const,
      source: 'chat' as const,
      risk,
      authorization,
      requiredAuthorization: authorization,
      verdict: 'review-allow' as const,
      audit: {
        risk: { native: null, published: null, point: risk, score: risk },
        authorization: {
          native: null,
          published: null,
          point: authorization,
          score: authorization,
        },
      },
    },
    attempts: base.attempts,
  });
  if (!checked.ok) {
    throw new TypeError(
      `the test record does not match its schema: ${checked.problems.join('; ')}`,
    );
  }
  return checked.document;
}
