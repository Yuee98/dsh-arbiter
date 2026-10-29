/**
 * Building a plan, a fixture and a run directory for a test.
 *
 * The runner's claims are about files: a record that is written once, an index that is
 * recomputed from the records, a fixture keyed by cell id. A test that asserted on
 * objects in memory would exercise a different path from the command a person runs, so
 * every helper here writes real files under a temporary directory and removes them
 * again.
 *
 * The plan is deliberately small — one or two cases, one or two targets — because the
 * behaviour under test is bounded dispatch, not throughput. What matters is that each
 * bound can be crossed by a plan a test can state, which is why `bounds` is a parameter
 * rather than a constant.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type {
  FixtureCell,
  FixtureChatScript,
  FixtureResponse,
  RunBounds,
  RunFixture,
  RunPlan,
  RunTarget,
} from '../../../evals/src/run/types.js';

/** A fresh temporary directory, removed when the test is done. */
export interface TemporaryArea {
  readonly path: string;
  write(relative: string, document: unknown): Promise<void>;
  remove(): Promise<void>;
}

/** One temporary area under the OS temp directory. */
export async function temporaryArea(): Promise<TemporaryArea> {
  const path = await mkdtemp(join(tmpdir(), 'arbiter-run-'));
  return {
    path,
    async write(relative: string, document: unknown): Promise<void> {
      const file = join(path, relative);
      await mkdir(join(file, '..'), { recursive: true });
      await writeFile(file, `${JSON.stringify(document, null, 2)}\n`, 'utf8');
    },
    async remove(): Promise<void> {
      await rm(path, { recursive: true, force: true });
    },
  };
}

/** Run one body against a temporary area that is always cleaned up. */
export async function withArea(
  body: (area: TemporaryArea) => Promise<void>,
): Promise<void> {
  const area = await temporaryArea();
  try {
    await body(area);
  } finally {
    await area.remove();
  }
}

/** One chat target, offering only chat. */
export function chatTarget(
  targetId = 'chat-a',
  overrides: Partial<RunTarget['chat'] & object> = {},
): RunTarget {
  return {
    targetId,
    provider: 'offline',
    model: 'offline-model',
    modelVersion: null,
    chat: {
      provider: 'offline',
      model: 'offline-model',
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 5_000,
      maxRepairRetries: 1,
      ...overrides,
    },
    decision: null,
    credentialRef: null,
  };
}

/** One decision target, offering only decision. */
export function decisionTarget(targetId = 'decision-a'): RunTarget {
  return {
    targetId,
    provider: 'offline-decision',
    model: 'offline-decision',
    modelVersion: null,
    chat: null,
    decision: {
      url: 'https://offline.test/v1/systemone',
      model: 'offline-decision',
      apiKeyRef: 'OFFLINE_KEY',
      timeoutMs: 5_000,
      costTier: 'free',
    },
    credentialRef: null,
  };
}

/** One target that offers both protocols, so a two-protocol plan has one source. */
export function dualTarget(targetId = 'dual-a'): RunTarget {
  const chat = chatTarget(targetId);
  const decision = decisionTarget(targetId);
  return {
    ...chat,
    provider: 'offline-dual',
    model: 'offline-dual',
    decision: decision.decision,
  };
}

/** The bounds a test starts from; each test overrides the one it is about. */
export function bounds(overrides: Partial<RunBounds> = {}): RunBounds {
  return {
    concurrency: 2,
    timeoutMs: 5_000,
    maxAttempts: 8,
    maxInputTokens: 20_000,
    ...overrides,
  };
}

/** A plan over the committed `core-v1` dataset. */
export function planOf(overrides: Partial<RunPlan> = {}): RunPlan {
  return {
    planVersion: 'eval-run-plan-v1',
    datasetId: 'core-v1',
    datasetPath: 'evals/datasets/core-v1',
    split: 'dev',
    caseIds: ['read-named-source-file'],
    transport: 'offline',
    protocols: ['chat'],
    targets: [chatTarget()],
    repeats: 1,
    bounds: bounds(),
    context: { maxInputTokens: 10_000 },
    fixture: 'fixture.json',
    notes: [],
    ...overrides,
  };
}

/** The cell id a case, target, protocol and repeat produce. */
export function cellIdOf(parts: {
  readonly caseId: string;
  readonly targetId: string;
  readonly protocol: 'chat' | 'decision';
  readonly repeat?: number;
}): string {
  return [
    parts.caseId,
    parts.targetId,
    parts.protocol,
    `r${String(parts.repeat ?? 1)}`,
  ].join('~');
}

/** One chat script that answers with a score pair and a usage payload. */
export function chatAnswer(
  risk: number,
  authorization: number,
  usage?: unknown,
): FixtureChatScript {
  return {
    kind: 'text',
    text: JSON.stringify({ risk, authorization }),
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * One native score answer, in the endpoint's own envelope.
 *
 * A decision answer is not a bare distribution: the endpoint wraps it as
 * `{type: 'score', probabilities}`. Building the wrapper here rather than at each call
 * site keeps a test from accidentally scripting an envelope the production parser
 * could never read, which would look like a parser failure rather than a fixture
 * mistake.
 */
export function scoreAnswer(probabilities: Readonly<Record<string, number>>): {
  readonly type: 'score';
  readonly probabilities: Record<string, number>;
} {
  return { type: 'score', probabilities: { ...probabilities } };
}

/**
 * A complete native distribution from a sparse one.
 *
 * The contract accepts exactly ten canonical native levels, so a distribution with two
 * entries is rejected as incomplete — which is the rule that stops a sparse answer from
 * being read as a confident one. A test that wants "mostly band 5" therefore has to say
 * what happens to the other nine, exactly as a real provider does.
 */
export function distribution(
  sparse: Readonly<Record<string, number>>,
): Record<string, number> {
  const full: Record<string, number> = {};
  let assigned = 0;
  for (const level of Object.keys(sparse).sort((left, right) =>
    left.localeCompare(right),
  )) {
    const value = sparse[level] ?? 0;
    full[level] = value;
    assigned += value;
  }
  // Whatever mass is unstated is spread evenly over the levels that were not named, so
  // the total is exactly one and no level is silently invented as the answer.
  const named = new Set(Object.keys(sparse));
  const rest = [
    ...Array.from({ length: 10 }, (_, level) => String(level)),
  ].filter((level) => !named.has(level));
  const leftover = Math.max(0, 1 - assigned);
  for (const level of rest) full[level] = leftover / rest.length;
  return full;
}

/** A decision response carrying both distributions and a usage payload. */
export function decisionAnswer(
  risk: Readonly<Record<string, number>>,
  authorization: Readonly<Record<string, number>>,
  options: { readonly usage?: unknown; readonly model?: string } = {},
): FixtureResponse {
  return {
    status: 200,
    body: JSON.stringify({
      model: options.model ?? 'offline-decision',
      answers: {
        risk: scoreAnswer(distribution(risk)),
        authorization: scoreAnswer(distribution(authorization)),
      },
      ...(options.usage === undefined ? {} : { usage: options.usage }),
    }),
  };
}

/** One cell's fixture entry. */
export function fixtureCell(parts: {
  readonly chat?: readonly FixtureChatScript[] | null;
  readonly decision?: readonly FixtureResponse[] | null;
}): FixtureCell {
  return {
    chat: parts.chat ?? null,
    decision: parts.decision ?? null,
  };
}

/** A fixture document over an explicit cell map. */
export function fixtureOf(
  cells: Readonly<Record<string, FixtureCell>>,
): RunFixture {
  return {
    fixtureVersion: 'eval-offline-fixture-v1',
    description: 'a scripted socket written by a test',
    cells,
    notes: [],
  };
}
