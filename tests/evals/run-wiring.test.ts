/**
 * The first wiring gap RQ-15 had to close before a real pilot could run.
 *
 * §4.1: an endpoint that authenticates nobody is expressible, and no fabricated bearer is
 * ever sent on its behalf. RQ-H1B's resource decision recorded this as a blocker: the
 * runner refused an empty credential reference, so a local service that authenticates
 * nobody could not be named at all.
 *
 * Nothing here reaches a network: every cell is answered by a scripted socket.
 */

import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { compileRunCheckers } from '../../evals/src/run/schemas.js';
import type { CellRecord, RunFixture } from '../../evals/src/run/types.js';
import {
  createRun,
  readExisting,
  resumeRun,
} from '../../evals/src/run/lifecycle.js';
import { readRun } from '../../evals/src/run/artifact.js';
import { planProblems } from '../../evals/src/run/plan.js';
import { coreCases, VERSIONS } from './helpers/report-run.js';
import {
  cellIdOf,
  decisionAnswer,
  decisionTarget,
  fixtureCell,
  fixtureOf,
  planOf,
  withArea,
} from './helpers/run.js';

/** Run one plan to completion in a directory and read its records back. */
async function dispatchPlan(parts: {
  readonly directory: string;
  readonly plan: ReturnType<typeof planOf>;
  readonly fixture: RunFixture;
  readonly llm: Parameters<typeof resumeRun>[0]['llm'];
  readonly readCredential: (name: string) => string | undefined;
}): Promise<readonly CellRecord[]> {
  const checkers = await compileRunCheckers();
  const loaded = await coreCases();
  const created = await createRun({
    directory: parts.directory,
    runId: 'wiring-run',
    plan: parts.plan,
    cases: loaded.cases,
    datasetDigest: loaded.digest,
    versions: VERSIONS,
    fixture: parts.fixture,
    now: () => 0,
  });
  if (!created.ok) throw new Error(created.problems.join('; '));
  const existing = await readExisting(parts.directory, parts.plan, checkers);
  if (!existing.ok) throw new Error(existing.problems.join('; '));
  await resumeRun({
    directory: parts.directory,
    existing: existing.existing,
    cases: loaded.cases,
    fixture: parts.fixture,
    versions: VERSIONS,
    checkers,
    llm: parts.llm,
    readCredential: parts.readCredential,
    signal: new AbortController().signal,
    continuation: false,
    now: () => 1_000,
  });
  const read = await readRun(parts.directory, checkers);
  if (!read.ok) throw new Error(JSON.stringify(read.problems));
  return read.artifact.records;
}

describe('§4.1 an endpoint that authenticates nobody is expressible', () => {
  it('sends a decision cell through a no-credential target and scores it', async () => {
    // The empty reference is the case that used to be refused before a cell was written.
    // The plan is legal, the preflight passes, and the cell produces a real outcome.
    await withArea(async (area) => {
      const cellId = cellIdOf({
        caseId: 'read-named-source-file',
        targetId: 'decision-local',
        protocol: 'decision',
      });
      const target = decisionTarget('decision-local');
      const plan = planOf({
        transport: 'offline',
        protocols: ['decision'],
        // Both reference sites empty: the plan states the endpoint needs no credential.
        targets: [
          {
            ...target,
            credentialRef: '',
            decision:
              target.decision === null
                ? null
                : { ...target.decision, apiKeyRef: '' },
          },
        ],
      });
      const fixture = fixtureOf({
        [cellId]: fixtureCell({
          decision: [decisionAnswer({ '1': 1 }, { '9': 1 })],
        }),
      });
      const records = await dispatchPlan({
        directory: join(area.path, 'run'),
        plan,
        fixture,
        llm: null,
        readCredential: () => undefined,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('reviewed');
      expect(records[0]?.outcome?.status).toBe('scored');
      // No credential means none was sent: the record says so by carrying an empty
      // reference rather than a name that resolved to nothing.
      expect(records[0]?.target.costTier).toBe('free');
    });
  });

  it('accepts the empty reference in the plan check instead of refusing the plan', () => {
    const target = decisionTarget('decision-local');
    const plan = planOf({
      transport: 'live',
      protocols: ['decision'],
      targets: [
        {
          ...target,
          credentialRef: '',
          decision:
            target.decision === null
              ? null
              : { ...target.decision, apiKeyRef: '' },
        },
      ],
      fixture: null,
    });
    expect(planProblems(plan)).toEqual([]);
  });

  it('keeps a named-but-unset credential a refusal, with no request sent', async () => {
    // The empty case is an exception, not a relaxation. A plan that names a variable and
    // cannot resolve it must still stop: the CLI refuses the whole run in its preflight,
    // and a caller that skipped that preflight gets a decided cell with no attempt rather
    // than a request carrying an empty bearer.
    await withArea(async (area) => {
      const target = decisionTarget('decision-remote');
      const plan = planOf({
        transport: 'live',
        protocols: ['decision'],
        targets: [
          {
            ...target,
            credentialRef: 'PROBE_KEY',
            decision:
              target.decision === null
                ? null
                : { ...target.decision, apiKeyRef: 'PROBE_KEY' },
          },
        ],
        fixture: null,
      });
      const records = await dispatchPlan({
        directory: join(area.path, 'run'),
        plan,
        fixture: fixtureOf({}),
        llm: null,
        readCredential: () => undefined,
      });
      expect(records).toHaveLength(1);
      expect(records[0]?.status).toBe('failed');
      expect(records[0]?.attempts).toEqual([]);
      expect(records[0]?.stopReason).toContain('PROBE_KEY');
    });
  });
});
