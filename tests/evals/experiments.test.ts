/**
 * The experiment configuration: the schema, the checks a schema cannot state, and the
 * dry run.
 *
 * Three things are pinned here, and each corresponds to one acceptance condition:
 *
 *   - a candidate has one identity and one diff, so two candidates cannot measure one
 *     package and a ladder step cannot quietly change two axes;
 *   - the frozen probe definition is the code's own — version, member, options and the
 *     `unknown` representation — so a definition cannot describe a question the reviewer
 *     does not ask;
 *   - the dry run measures every cell it would send and refuses a matrix that does not
 *     fit its own ceiling, without writing anything.
 */

import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, test } from 'vitest';

import { digestOf } from '../../evals/src/data/hash.js';
import {
  checkExperiments,
  expandDefinition,
  planExperiment,
} from '../../evals/src/experiments/commands.js';
import type { ExperimentIo } from '../../evals/src/experiments/commands.js';
import {
  budgetProblemsOf,
  experimentProblemsOf,
  requiredRequests,
} from '../../evals/src/experiments/commands.js';
import { resolveCandidates } from '../../evals/src/experiments/inspect.js';
import { loadCases } from '../../evals/src/experiments/load.js';
import { caseMaterial } from '../../evals/src/run/material.js';
import {
  cacheProblems,
  cacheStepsOf,
  composedCase,
  expandCache,
} from '../../evals/src/experiments/cache.js';
import { splitAtAction } from '../../evals/src/experiments/matrix.js';
import { definitionProblems } from '../../evals/src/experiments/inspect.js';
import type { ExperimentCell } from '../../evals/src/experiments/matrix.js';
import {
  compileExperimentCheckers,
  EXPERIMENT_SCHEMA,
} from '../../evals/src/experiments/schemas.js';
import type { ReviewCase } from '../../evals/src/data/types.js';
import { EXPERIMENT_VERSION } from '../../evals/src/experiments/types.js';
import type { ExperimentDefinition } from '../../evals/src/experiments/types.js';
import {
  PROBE_MEMBER,
  PROBE_OPTIONS,
  REVIEW_PROBE_VERSION,
} from '../../src/reviewer/probe.js';
import { PRODUCTION_VARIANT } from '../../src/reviewer/variant.js';

import { REPOSITORY_ROOT } from './helpers/dataset.js';
import {
  arrayAt,
  cloneJson,
  firstObjectOf,
  isRecord,
  objectAt,
} from './helpers/doc-edit.js';

/** The committed definition, relative to the repository root. */
const DEFINITION_PATH = 'evals/experiments/rq14-matrix.json';

/**
 * The dry run's output, computed once for the whole file.
 *
 * Expanding the committed matrix renders every cell of every candidate, which measures
 * about 1.3 s here and several times that on a hosted runner. A test that only reads the
 * report must not re-render the matrix for its own assertions: six tests each doing so is
 * what made hosted unit runs exceed the 5 s per-test limit. The lazy promise keeps one
 * expansion for all of them and still fails loudly if it fails.
 */
let planReport: Promise<{
  readonly lines: string[];
  readonly problems: string[];
}> | null = null;

function planReportOnce(): Promise<{
  readonly lines: string[];
  readonly problems: string[];
}> {
  planReport ??= (async () => {
    const io = recorder();
    const status = await planExperiment(io, DEFINITION_PATH);
    return {
      lines: [...io.lines, `status ${String(status)}`],
      problems: io.problems,
    };
  })();
  return planReport;
}

/** The committed definition with its selected cases, computed once for these cases. */
let expandedSelection: Promise<{
  readonly definition: ExperimentDefinition;
  readonly cases: readonly ReviewCase[];
}> | null = null;

/** The expanded committed matrix, computed once for the whole file. */
let committedExpansion: Promise<
  Awaited<ReturnType<typeof expandDefinition>>
> | null = null;

function expansionOnce(): Promise<
  Awaited<ReturnType<typeof expandDefinition>>
> {
  committedExpansion ??= expandDefinition(QUIET, DEFINITION_PATH);
  return committedExpansion;
}

/** A buffer that captures what a command printed. */
function recorder(): ExperimentIo & {
  readonly lines: string[];
  readonly problems: string[];
} {
  const lines: string[] = [];
  const problems: string[] = [];
  return {
    root: REPOSITORY_ROOT,
    out: (line) => lines.push(line),
    err: (line) => problems.push(line),
    lines,
    problems,
  };
}

/** A command target that prints nowhere, for a test that only wants the expansion. */
const QUIET: ExperimentIo = {
  root: REPOSITORY_ROOT,
  out: () => undefined,
  err: () => undefined,
};

/** The committed definition's text, exactly as the file holds it. */
async function committedText(): Promise<string> {
  return readFile(`${REPOSITORY_ROOT}${DEFINITION_PATH}`, 'utf8');
}

/** The committed definition as an unvalidated document. */
async function committed(): Promise<unknown> {
  return JSON.parse(await committedText()) as unknown;
}

/** A checked copy of the committed definition, freshly parsed for each test. */
async function committedDefinition(): Promise<ExperimentDefinition> {
  // Read from the file each time: a test that edits "the definition" must edit its own
  // copy, and a shared object would let one test's mutation leak into the next.
  const checkers = await compileExperimentCheckers();
  const checked = checkers.experiment(await committed());
  if (!checked.ok) throw new Error(checked.problems.join('; '));
  return checked.document;
}

/**
 * One readonly field, made writable so a test can break it.
 *
 * The committed types are frozen because a definition is; a test that has to show what a
 * *broken* definition does edits one field at a time through this, which keeps the edit
 * explicit instead of asserting a whole document into a looser type.
 */
function mutate<T extends object>(
  value: T,
): { -readonly [Key in keyof T]: T[Key] } {
  return value;
}

/** One ladder step by position, or a throw when the ladder is empty. */
function stepAt(
  definition: ExperimentDefinition,
  index: number,
): ExperimentDefinition['ladder'][number] {
  const found = definition.ladder[index];
  if (found === undefined) {
    throw new TypeError(`no ladder step ${String(index)}`);
  }
  return found;
}

/** One candidate by id, or a throw naming the id that is missing. */
function candidateOf(
  definition: ExperimentDefinition,
  candidateId: string,
): (typeof definition.candidates)[number] {
  const found = definition.candidates.find(
    (entry) => entry.candidateId === candidateId,
  );
  if (found === undefined) throw new TypeError(`no candidate ${candidateId}`);
  return found;
}

/** One deep copy a test may edit, as loose JSON. */
async function editable(): Promise<unknown> {
  return cloneJson(await committed());
}

/** Write an edited document to a temporary file and run one body against it. */
async function withDocument(
  document: unknown,
  body: (path: string) => Promise<void>,
): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'arbiter-experiment-'));
  try {
    const path = join(directory, 'definition.json');
    await writeFile(path, JSON.stringify(document), 'utf8');
    await body(path);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe('the experiment schema', () => {
  test('accepts the committed definition', async () => {
    const checkers = await compileExperimentCheckers();
    const checked = checkers.experiment(await committed());
    expect(checked.ok).toBe(true);
    const document = await committedDefinition();
    expect(document.experimentVersion).toBe(EXPERIMENT_VERSION);
    // Candidates A and B are the issue's two required packages.
    expect(document.candidates.map((entry) => entry.candidateId)).toEqual(
      expect.arrayContaining(['A', 'B']),
    );
  });

  test('refuses a candidate with an axis outside the vocabulary', async () => {
    const checkers = await compileExperimentCheckers();
    const document = await editable();
    const axes = objectAt(
      firstObjectOf(arrayAt(document, 'candidates')),
      'axes',
    );
    axes['prompt'] = 'two-probes';
    expect(checkers.experiment(document).ok).toBe(false);
  });

  test('refuses a ladder step that declares two changed axes', async () => {
    const checkers = await compileExperimentCheckers();
    const document = await editable();
    firstObjectOf(arrayAt(document, 'ladder'))['changes'] = ['prompt', 'scale'];
    expect(checkers.experiment(document).ok).toBe(false);
  });

  test('refuses a definition that names no unknown representation', async () => {
    const checkers = await compileExperimentCheckers();
    const document = await editable();
    objectAt(document, 'probe')['unknown'] = 'maybe';
    expect(checkers.experiment(document).ok).toBe(false);
  });

  test('refuses a budget with no ceilings at all', async () => {
    const checkers = await compileExperimentCheckers();
    const document = await editable();
    if (!isRecord(document)) throw new TypeError('the definition is not JSON');
    delete document['budget'];
    expect(checkers.experiment(document).ok).toBe(false);
  });

  test('compiles from a schema path a caller can move', async () => {
    // The definition's schema lives beside its data, so the loader is given the path
    // rather than reaching into a hard-coded directory.
    const checkers = await compileExperimentCheckers({
      schema: EXPERIMENT_SCHEMA,
    });
    expect(checkers.experiment(await committed()).ok).toBe(true);
  });
});

describe('the checks a schema cannot state', () => {
  test('the committed definition has none', async () => {
    expect(definitionProblems(await committedDefinition())).toEqual([]);
  });

  test('requires one candidate to be production, unchanged', async () => {
    const definition = await committedDefinition();
    for (const candidate of definition.candidates) {
      mutate(candidate.axes).structure = 'compact';
    }
    const problems = definitionProblems(definition);
    expect(problems.join('\n')).toContain(
      'no candidate is the production package',
    );
    expect(problems.join('\n')).toContain(PRODUCTION_VARIANT.variantId);
  });

  test('refuses two candidates that name one package', async () => {
    const definition = await committedDefinition();
    // Copying A's axes onto C1 makes two candidates measure one package; the ladder then
    // stops being a ladder too, which is exactly why both checks run.
    mutate(candidateOf(definition, 'C1')).axes = candidateOf(
      definition,
      'A',
    ).axes;
    expect(definitionProblems(definition).join('\n')).toContain(
      'duplicates package',
    );
  });

  test('refuses a matrix with no candidate asking the probe', async () => {
    const definition = await committedDefinition();
    for (const candidate of definition.candidates) {
      mutate(candidate.axes).prompt = 'no-probe';
    }
    expect(definitionProblems(definition).join('\n')).toContain(
      'no candidate asks the recovery probe',
    );
  });

  test('refuses a ladder step whose declared axis is not the one that changed', async () => {
    const definition = await committedDefinition();
    mutate(stepAt(definition, 0)).changes = ['scale'];
    expect(definitionProblems(definition).join('\n')).toContain(
      'declares scale but actually changes',
    );
  });

  test('refuses a ladder step built on something that does not exist', async () => {
    const definition = await committedDefinition();
    mutate(stepAt(definition, 0)).from = 'not-a-candidate';
    expect(definitionProblems(definition).join('\n')).toContain(
      'which is neither a candidate nor an earlier step',
    );
  });

  test('refuses a probe definition that diverges from the code', async () => {
    const definition = await committedDefinition();
    const probe = mutate(definition.probe);
    probe.version = 'review-probe-v0';
    probe.member = 'reversible';
    probe.options = ['yes', 'no'];
    const problems = definitionProblems(definition).join('\n');
    expect(problems).toContain(REVIEW_PROBE_VERSION);
    expect(problems).toContain(PROBE_MEMBER);
    expect(problems).toContain(PROBE_OPTIONS.join(','));
  });

  test('refuses a probe that cannot answer "the material is unclear"', async () => {
    const definition = await committedDefinition();
    mutate(definition.probe).options = [
      'withdrawn',
      'recoverable',
      'partially-recoverable',
      'irreversible',
    ];
    expect(definitionProblems(definition).join('\n')).toContain(
      'are not the reviewer',
    );
  });

  test('refuses a probe whose band rule does not fix the risk definition', async () => {
    const definition = await committedDefinition();
    mutate(definition.probe).bandRule =
      'Recoverability may lower the risk band.';
    expect(definitionProblems(definition).join('\n')).toContain(
      'does not state that the probe never changes a band',
    );
  });

  test('refuses a probe whose withdrawn rule does not name withdrawal', async () => {
    const definition = await committedDefinition();
    mutate(definition.probe).withdrawnRule = 'Nothing to see here.';
    expect(definitionProblems(definition).join('\n')).toContain(
      'does not name withdrawal',
    );
  });

  test('refuses a cache workload with no cold request', async () => {
    const definition = await committedDefinition();
    mutate(definition.cache).sequence = [{ role: 'stable-prefix', repeats: 2 }];
    expect(definitionProblems(definition).join('\n')).toContain(
      'no cold request',
    );
  });

  test('refuses a budget no matrix of this size could fit', async () => {
    const definition = await committedDefinition();
    const budget = mutate(definition.budget);
    budget.maxRequests = 1;
    budget.maxRepairRetries = definition.bounds.maxAttempts + 1;
    const problems = definitionProblems(definition).join('\n');
    expect(problems).toContain('cannot cover the matrix');
    // The repair allowance is compared with the run's own ceiling, not with a number
    // this module keeps: a retry budget above it could never be spent.
    expect(problems).toContain('exceeds the run');
  });
});

describe('the dry run', () => {
  test('measures every cell without writing anything', async () => {
    const report = await planReportOnce();
    // No problems, and the run's own status printed as zero: "wrote nothing" is a claim
    // about the command's exit code as much as about the filesystem.
    expect(report.problems).toEqual([]);
    const printed = report.lines.join('\n');
    expect(printed).toContain('status 0');
    // Every candidate is measured, not merely listed.
    for (const id of ['A', 'B', 'C1', 'C2', 'C3', 'C4']) {
      expect(printed).toContain(`candidate ${id} `);
    }
    expect(printed).toContain('distinct requests');
    expect(printed).toContain('estimated input tokens');
    expect(printed).toContain(
      'dry run only: nothing was sent and nothing was written',
    );
    // The numbers are measured, so a candidate cannot have zero tokens.
    expect(printed).not.toContain(' 0 estimated input tokens');
  });

  test('measures a difference for every candidate that differs', async () => {
    const expanded = await expansionOnce();
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const cellsOf = new Map(
      expanded.expanded.matrix.candidates.map((entry) => [
        entry.candidate.candidateId,
        entry,
      ]),
    );
    const a = cellsOf.get('A');
    const b = cellsOf.get('B');
    // Candidate B differs from A in exactly the probe, and the measured input grows by
    // the question's own length: a treatment that costs nothing would not be one.
    expect(a?.estimatedInputTokens ?? 0).toBeLessThan(
      b?.estimatedInputTokens ?? 0,
    );
    expect(a?.cells.length).toBe(b?.cells.length);
    // Both repeats of one case are separate cells but one distinct request, so the
    // repeat count divides the cell count exactly.
    expect(a?.distinctRequests).toBe((a?.cells.length ?? 0) / 2);
  });

  test('reports each candidate’s difference from production', async () => {
    const printed = (await planReportOnce()).lines.join('\n');
    expect(printed).toContain(
      'candidate A rq14/no-probe.complete.current-turn.full',
    );
    expect(printed).toContain('(changes none)');
    expect(printed).toContain(
      'candidate B rq14/recovery-probe.complete.current-turn.full',
    );
    expect(printed).toContain('(changes prompt)');
    expect(printed).toContain('(changes structure)');
    expect(printed).toContain('(changes history+structure)');
    expect(printed).toContain('(changes scale+structure)');
  });

  test('refuses a matrix that does not fit its own measured ceiling', async () => {
    const document = await editable();
    objectAt(document, 'budget')['maxInputTokensTotal'] = 1;
    await withDocument(document, async (path) => {
      const io = recorder();
      expect(await planExperiment(io, path)).toBe(1);
      // Both ceilings are compared: the matrix's measured total, and the per-cell bound
      // one dispatch could break.
      expect(io.problems.join('\n')).toContain('maxInputTokensTotal');
      expect(io.problems.join('\n')).toContain('exceeds the experiment');
    });
  });

  test('refuses a selection its dataset does not publish', async () => {
    const document = await editable();
    objectAt(document, 'dataset')['caseIds'] = ['no-such-case'];
    await withDocument(document, async (path) => {
      const io = recorder();
      expect(await planExperiment(io, path)).toBe(1);
      expect(io.problems.join('\n')).toContain('does not publish');
    });
  });

  test('refuses a dataset whose identity is not the one it names', async () => {
    const document = await editable();
    objectAt(document, 'dataset')['datasetId'] = 'not-core';
    await withDocument(document, async (path) => {
      const io = recorder();
      expect(await planExperiment(io, path)).toBe(1);
      expect(io.problems.join('\n')).toContain('declares itself core-v1');
    });
  });

  test('checks every committed definition and measures it', async () => {
    const io = recorder();
    expect(await checkExperiments(io)).toBe(0);
    expect(io.lines.join('\n')).toContain('rq14-matrix.json');
    expect(io.lines.join('\n')).toContain('estimated input tokens');
  });
});

describe('the cache workload is a measured sequence', () => {
  test('expands to the requests its labels name', async () => {
    const expanded = await expansionOnce();
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const { cache, definition } = expanded.expanded;
    // Four slots are four requests: a label that expanded to nothing would be a
    // description rather than a workload.
    expect(cache.requests).toBe(
      definition.cache.sequence.reduce((sum, slot) => sum + slot.repeats, 0),
    );
    expect(cache.cells).toHaveLength(cache.requests);
    // Each request names the case its action came from.
    expect(cache.cells.map((cell) => cell.role)).toEqual([
      'cold',
      'stable-prefix',
      'stable-prefix',
      'changed-action',
      'changed-action',
    ]);
    for (const cell of cache.cells) {
      expect(cell.actionCaseId.length).toBeGreaterThan(0);
      expect(cell.estimatedInputTokens).toBeGreaterThan(0);
    }
    // A re-use submits the base case's own action; only a changed slot names another.
    expect(
      cache.cells
        .filter((cell) => cell.role !== 'changed-action')
        .map((cell) => cell.actionCaseId),
    ).toEqual(
      cache.cells
        .filter((cell) => cell.role !== 'changed-action')
        .map(() => definition.cache.baseCaseId),
    );
    expect(
      cache.cells
        .filter((cell) => cell.role === 'changed-action')
        .map((cell) => cell.actionCaseId),
    ).toEqual([...definition.cache.changedActionCaseIds]);
  });

  test('proves the stable prefix is one byte-identical region', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const prefixes = new Set(
      expanded.expanded.cache.cells.map((cell) => cell.stablePrefixFingerprint),
    );
    // One prefix, established by measuring the rendered requests: that is the claim a
    // provider's prefix cache would depend on.
    expect(prefixes.size).toBe(1);
    expect([...prefixes][0]).not.toBeNull();
  });

  test('proves each changed action really changes the action region', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { cache } = expanded.expanded;
    const [cold] = cache.cells;
    if (cold === undefined) throw new Error('no cold request');
    const changed = cache.cells.filter(
      (cell) => cell.role === 'changed-action',
    );
    const reused = cache.cells.filter((cell) => cell.role !== 'changed-action');
    expect(changed.length).toBeGreaterThan(0);
    for (const cell of changed) {
      expect(cell.actionFingerprint).not.toBe(cold.actionFingerprint);
    }
    // A non-changed slot re-submits the very same action, so only the changed ones move.
    for (const cell of reused) {
      expect(cell.actionFingerprint).toBe(cold.actionFingerprint);
    }
    expect(new Set(changed.map((cell) => cell.actionFingerprint)).size).toBe(
      changed.length,
    );
  });

  test('finds the action boundary in every layout, not only production’s', async () => {
    // The split is what turns a request into "prefix" and "action", so it has to work on
    // the layout the candidate under test actually submits. A split that only knew the
    // production block label would report every compact candidate as unmeasurable.
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition } = expanded.expanded;
    const compact = definition.candidates.filter((entry) =>
      entry.axes.structure.startsWith('compact'),
    );
    expect(compact.length).toBeGreaterThan(0);
    // Both layouts are named by the committed matrix; the expansion above proved the
    // production one splits, and the compact member form is checked directly here.
    expect(
      splitAtAction(
        'POLICY_AND_GUIDANCE\n{}\n\n{\n  "pending_action": {\n    "name": "bash"\n  }\n}',
      ),
    ).not.toBeNull();
    expect(
      splitAtAction(
        'POLICY_AND_GUIDANCE\n{}\n\nPENDING_ACTION\n{\n  "name": "bash"\n}',
      ),
    ).not.toBeNull();
    // A material with neither boundary is reported, never guessed at.
    expect(splitAtAction('nothing that looks like a layout')).toBeNull();
  });

  test('counts the workload in the budget instead of describing it', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition, matrix, cache } = expanded.expanded;
    // The request ceiling has to cover the cache workload too: raising its repeats adds
    // real requests, so the number the check compares has to move with them.
    const before = requiredRequests(definition, matrix, cache);
    const doubled = {
      ...cache,
      requests: cache.requests * 2,
      estimatedInputTokens: cache.estimatedInputTokens * 2,
    };
    expect(requiredRequests(definition, matrix, doubled)).toBe(
      before + cache.requests,
    );
    // Every request is charged, including the ones whose bytes a matrix cell already
    // sends: whether an earlier dispatch happened is an execution fact, not a discount.
    expect(before).toBe(
      matrix.cells +
        cache.requests +
        definition.budget.maxRepairRetries * matrix.cells,
    );
  });

  test('refuses a workload whose repeats outrun the actions it names', () => {
    const check = async (): Promise<readonly string[]> => {
      const expanded = await expansionOnce();
      if (!expanded.ok)
        throw new Error('the committed definition did not expand');
      const { definition, cache } = expanded.expanded;
      return cacheProblems({
        expansion: cache,
        definition: {
          ...definition.cache,
          sequence: definition.cache.sequence.map((slot) =>
            slot.role === 'changed-action' ? { ...slot, repeats: 9 } : slot,
          ),
        },
        bounds: definition.bounds,
      });
    };
    return check().then((problems) => {
      expect(problems.join('\n')).toContain('changed action');
    });
  });

  test('refuses a workload whose actions are all identical', () => {
    const check = async (): Promise<readonly string[]> => {
      const expanded = await expansionOnce();
      if (!expanded.ok)
        throw new Error('the committed definition did not expand');
      const { definition, cache } = expanded.expanded;
      const [first] = definition.cache.changedActionCaseIds;
      if (first === undefined) throw new Error('no changed action');
      return cacheProblems({
        expansion: cache,
        definition: {
          ...definition.cache,
          changedActionCaseIds: [first, first],
        },
        bounds: definition.bounds,
      });
    };
    return check().then((problems) => {
      expect(problems.join('\n')).toContain('same changed action');
    });
  });
});

describe('the cache workload refuses material it cannot measure', () => {
  /** The committed definition's selection, expanded once for this block. */
  const selection = (): Promise<{
    readonly definition: ExperimentDefinition;
    readonly cases: readonly ReviewCase[];
  }> => {
    expandedSelection ??= (async () => {
      const definition = await committedDefinition();
      const loaded = await loadCases(QUIET, definition);
      if (!loaded.ok) throw new Error(loaded.problems.join('; '));
      return { definition, cases: loaded.cases };
    })();
    return expandedSelection;
  };

  /** One candidate, resolved, for a workload built directly. */
  const candidateA = async (): Promise<
    ReturnType<typeof resolveCandidates>[number]
  > => {
    const { definition } = await selection();
    const [first] = resolveCandidates(definition);
    if (first === undefined) throw new Error('no candidate');
    return first;
  };

  test('refuses a sequence with no changed action at all', async () => {
    const { cases } = await selection();
    const sequence = [
      { role: 'cold' as const, repeats: 1 },
      { role: 'stable-prefix' as const, repeats: 2 },
    ];
    const expansion = expandCache({
      candidate: await candidateA(),
      cases,
      protocol: 'chat',
      baseCaseId: 'delete-generated-output-authorized',
      sequence,
      changedActionCaseIds: [],
      maxInputTokens: 20_000,
    });
    // A warm-up workload measures a prefix re-use and nothing about whether the action
    // moved, which is one of the three things the issue requires.
    expect(
      cacheProblems({
        expansion,
        definition: {
          sequence,
          baseCaseId: 'delete-generated-output-authorized',
          changedActionCaseIds: [],
        },
        bounds: { maxInputTokens: 20_000 },
        caseIds: cases.map((entry) => entry.caseId),
      }).join('\n'),
    ).toContain('no changed-action request');
  });

  test('refuses an action case the selection does not publish', async () => {
    const { cases } = await selection();
    const sequence = [
      { role: 'cold' as const, repeats: 1 },
      { role: 'changed-action' as const, repeats: 1 },
    ];
    const expansion = expandCache({
      candidate: await candidateA(),
      cases,
      protocol: 'chat',
      baseCaseId: 'delete-generated-output-authorized',
      sequence,
      changedActionCaseIds: ['no-such-case'],
      maxInputTokens: 20_000,
    });
    // The request would silently disappear; the count check catches the shortfall and
    // the id check names which case is missing.
    const problems = cacheProblems({
      expansion,
      definition: {
        sequence,
        baseCaseId: 'delete-generated-output-authorized',
        changedActionCaseIds: ['no-such-case'],
      },
      bounds: { maxInputTokens: 20_000 },
      caseIds: cases.map((entry) => entry.caseId),
    }).join('\n');
    expect(problems).toContain('expands to 1');
    expect(problems).toContain('no-such-case');
  });

  test('keeps the changed-action cursor cumulative across slots', async () => {
    const { cases } = await selection();
    // Splitting one `changed-action x2` into two `x1` slots must submit two different
    // actions: a cursor that restarts per slot would repeat the first and drop the second.
    const steps = cacheStepsOf({
      sequence: [
        { role: 'cold', repeats: 1 },
        { role: 'changed-action', repeats: 1 },
        { role: 'changed-action', repeats: 1 },
      ],
      baseCaseId: 'delete-generated-output-authorized',
      changedActionCaseIds: [
        'delete-uncommitted-drafts',
        'cleanup-stale-cache-dir',
      ],
    });
    expect(steps.map((step) => step.actionCaseId)).toEqual([
      'delete-generated-output-authorized',
      'delete-uncommitted-drafts',
      'cleanup-stale-cache-dir',
    ]);
    // And the expansion agrees with the steps rather than re-deriving them.
    const expansion = expandCache({
      candidate: await candidateA(),
      cases,
      protocol: 'chat',
      baseCaseId: 'delete-generated-output-authorized',
      sequence: [
        { role: 'cold', repeats: 1 },
        { role: 'changed-action', repeats: 1 },
        { role: 'changed-action', repeats: 1 },
      ],
      changedActionCaseIds: [
        'delete-uncommitted-drafts',
        'cleanup-stale-cache-dir',
      ],
      maxInputTokens: 20_000,
    });
    expect(
      expansion.cells
        .filter((cell) => cell.role === 'changed-action')
        .map((cell) => cell.actionCaseId),
    ).toEqual(['delete-uncommitted-drafts', 'cleanup-stale-cache-dir']);
  });

  test('evaluates a composed action in the directory it is told it runs in', async () => {
    const { cases } = await selection();
    const base = cases.find(
      (entry) => entry.caseId === 'delete-generated-output-authorized',
    );
    const action = cases.find(
      (entry) => entry.caseId === 'delete-uncommitted-drafts',
    );
    if (base === undefined || action === undefined) {
      throw new Error('the committed selection changed');
    }
    // The action case has its own directory; the composition deliberately keeps the base
    // case's, so the command line and the derived effects describe one place.
    expect(base.input.cwd).not.toBe(action.input.cwd);
    const composed = caseMaterial(composedCase(base, action), 'chat', {
      maxInputTokens: 20_000,
    });
    expect(composed.snapshot.cwd).toBe(base.input.cwd);
    // The relative path resolved against the submitted directory, not the action case's.
    expect(composed.snapshot.facts?.observed.writes).toContain(
      `${String(base.input.cwd)}/drafts/export-2026-10-29`,
    );
    // The base case's hint would point at an action this request does not submit, so
    // it is not inherited; the action case's own hint still travels with its action.
    expect(composed.snapshot.hint).toBeUndefined();
    const hinted = {
      ...action,
      input: { ...action.input, hint: 'a hint that belongs to this action' },
    };
    expect(composedCase(base, hinted).input.hint).toBe(
      'a hint that belongs to this action',
    );
  });

  test('refuses a cache request measured above the per-request ceiling', async () => {
    const { cases } = await selection();
    const sequence = [
      { role: 'cold' as const, repeats: 1 },
      { role: 'changed-action' as const, repeats: 1 },
    ];
    const expansion = expandCache({
      candidate: await candidateA(),
      cases,
      protocol: 'chat',
      baseCaseId: 'delete-generated-output-authorized',
      sequence,
      changedActionCaseIds: ['delete-uncommitted-drafts'],
      maxInputTokens: 20_000,
    });
    // The measured comparison, not only the production marker: an inherited flag would
    // describe a smaller submission than the one this request contains.
    const problems = cacheProblems({
      expansion,
      definition: {
        sequence,
        baseCaseId: 'delete-generated-output-authorized',
        changedActionCaseIds: ['delete-uncommitted-drafts'],
      },
      bounds: { maxInputTokens: 10 },
      caseIds: cases.map((entry) => entry.caseId),
    }).join('\n');
    expect(problems).toContain('per-request ceiling');
    expect(problems).toContain('measures');
  });

  test('the plan refuses a workload check-all would refuse', async () => {
    const document = await editable();
    objectAt(document, 'cache')['changedActionCaseIds'] = [
      // A real, selected case whose action is identical to the cold request's.
      'delete-generated-output-no-permission',
      'delete-uncommitted-drafts',
    ];
    await withDocument(document, async (path) => {
      const io = recorder();
      expect(await planExperiment(io, path)).toBe(1);
      // The same standard the writing command applies, on the entry point that
      // advertises a validated dry run.
      expect(io.problems.join('\n')).toContain('unchanged');
    });
  });
});

describe('the three commands agree on what is valid', () => {
  test('share one problem set', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition, cases, matrix, cache } = expanded.expanded;
    // `experimentProblemsOf` is what plan, check-all and record all call; a command that
    // assembled its own subset could accept what another refuses.
    expect(experimentProblemsOf(definition, matrix, cache, cases)).toEqual([
      ...cacheProblems({
        expansion: cache,
        definition: definition.cache,
        bounds: definition.bounds,
        caseIds: cases.map((entry) => entry.caseId),
      }),
      ...budgetProblemsOf(definition, matrix, cache),
    ]);
    // And the committed definition passes it.
    expect(experimentProblemsOf(definition, matrix, cache, cases)).toEqual([]);
  });
});

describe('the budget respects the bounds it reuses', () => {
  test('refuses a matrix one run could not finish', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition, matrix, cache } = expanded.expanded;
    const problems = budgetProblemsOf(
      { ...definition, bounds: { ...definition.bounds, maxAttempts: 24 } },
      matrix,
      cache,
    );
    // `maxAttempts` is the run ceiling from the reused RQ-10 contract; a plan needing
    // more dispatches than it is a plan no single run could execute.
    expect(problems.join('\n')).toContain('maxAttempts');
    expect(problems.join('\n')).toContain('one run');
  });

  test('refuses a request measured above the per-request ceiling', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition, matrix, cache } = expanded.expanded;
    const problems = budgetProblemsOf(
      // A ceiling below every measured cell: each one is over its own bound.
      { ...definition, bounds: { ...definition.bounds, maxInputTokens: 1 } },
      matrix,
      cache,
    );
    expect(problems.join('\n')).toContain('per-request ceiling');
    // It names the measured value and the cell, so the report is checkable.
    expect(problems.join('\n')).toContain('measures');
  });

  test('passes the committed definition under both its ceilings', async () => {
    const expanded = await expansionOnce();
    if (!expanded.ok) return;
    const { definition, matrix, cache } = expanded.expanded;
    expect(budgetProblemsOf(definition, matrix, cache)).toEqual([]);
    // And the run bound really does cover what was measured.
    expect(requiredRequests(definition, matrix, cache)).toBeLessThanOrEqual(
      definition.bounds.maxAttempts,
    );
  });
});

describe('the committed record', () => {
  test('names the definition it froze, by digest', async () => {
    const record: unknown = JSON.parse(
      await readFile(`${REPOSITORY_ROOT}evals/experiments/record.json`, 'utf8'),
    );
    expect(isRecord(record)).toBe(true);
    if (!isRecord(record)) return;
    // A record pinned to a different digest than the committed definition describes an
    // experiment nobody is running; the two files have to move together.
    expect(record['definitionDigest']).toBe(digestOf(await committed()));
    expect(record['experimentVersion']).toBe(EXPERIMENT_VERSION);
  });

  test('states one identity per candidate, matching the definition’s axes', async () => {
    const record: unknown = JSON.parse(
      await readFile(`${REPOSITORY_ROOT}evals/experiments/record.json`, 'utf8'),
    );
    if (!isRecord(record)) throw new TypeError('the record is not an object');
    const candidates = arrayAt(record, 'candidates').map((entry) => {
      if (!isRecord(entry)) throw new TypeError('a candidate is not an object');
      return entry;
    });
    const definition = await committedDefinition();
    expect(candidates.map((entry) => entry['candidateId'])).toEqual(
      definition.candidates.map((entry) => entry.candidateId),
    );
    // Every candidate is one package, and the recorded identity is the derived one.
    const ids = candidates.map((entry) => entry['variantId']);
    expect(typeof ids[0]).toBe('string');
    expect(new Set(ids).size).toBe(ids.length);
    for (const candidate of candidates) {
      expect(typeof candidate['variantId']).toBe('string');
      // The diff is recorded, not implied: candidate A changes nothing, B only prompts.
      expect(candidate['changesFromProduction']).toBeDefined();
    }
    expect(candidates[0]?.['changesFromProduction']).toEqual([]);
    expect(candidates[1]?.['changesFromProduction']).toEqual(['prompt']);
  });

  test('fixes the probe definition and the unknown representation', async () => {
    const record: unknown = JSON.parse(
      await readFile(`${REPOSITORY_ROOT}evals/experiments/record.json`, 'utf8'),
    );
    if (!isRecord(record)) throw new TypeError('the record is not an object');
    const probe = objectAt(record, 'probe');
    expect(probe['version']).toBe(REVIEW_PROBE_VERSION);
    expect(probe['member']).toBe(PROBE_MEMBER);
    expect(probe['options']).toEqual([...PROBE_OPTIONS]);
    expect(probe['unknown']).toBe('unknown');
    // The record says what it is: a matrix, not a result.
    expect(record['status']).toContain('no candidate was selected');
  });
});

describe('the candidate fingerprints', () => {
  test('differ wherever a candidate differs, so a diff is observable', async () => {
    const expanded = await expansionOnce();
    expect(expanded.ok).toBe(true);
    if (!expanded.ok) return;
    const byCandidate = new Map(
      expanded.expanded.matrix.candidates.map((entry) => [
        entry.candidate.candidateId,
        entry.cells,
      ]),
    );
    // One fingerprint per cell position, so two candidates can be compared cell by cell.
    const fingerprintAt = (candidateId: string): readonly ExperimentCell[] =>
      byCandidate.get(candidateId) ?? [];
    const a = fingerprintAt('A');
    const b = fingerprintAt('B');
    expect(a).toHaveLength(b.length);
    // B asks one more question, so every cell it submits is a different request.
    expect(a.map((cell) => cell.promptFingerprint)).not.toEqual(
      b.map((cell) => cell.promptFingerprint),
    );
    for (const [index, cell] of a.entries()) {
      expect(cell.cellId).not.toBe(b[index]?.cellId);
      expect(cell.promptFingerprint).not.toBe(b[index]?.promptFingerprint);
    }
    // A repeat of the same cell is a different cell with the same request.
    const firstRepeat = a[0];
    const secondRepeat = a[1];
    expect(firstRepeat?.caseId).toBe(secondRepeat?.caseId);
    expect(firstRepeat?.promptFingerprint).toBe(
      secondRepeat?.promptFingerprint,
    );
  });
});

describe('the committed definition', () => {
  test('selects the development split and repeats each cell', async () => {
    const definition = await committedDefinition();
    // The comparison must be made over cases a later run may tune against: the holdout
    // exists so the final verification is not one, so an ablation selects dev here.
    expect(definition.dataset.split).toBe('dev');
    // Both protocols are compared, because the issue requires their candidate semantics
    // to agree; the probe travels differently in each, which is what the matrix checks.
    expect(definition.protocols).toEqual(['chat', 'decision']);
    expect(definition.repeats).toBeGreaterThan(1);
  });

  test('fixes the probe vocabulary the reviewer actually asks', async () => {
    const definition = await committedDefinition();
    expect(definition.probe.version).toBe(REVIEW_PROBE_VERSION);
    expect(definition.probe.member).toBe(PROBE_MEMBER);
    expect(definition.probe.options).toEqual([...PROBE_OPTIONS]);
    // `unknown` is an option, not an absence.
    expect(definition.probe.options).toContain('unknown');
    expect(definition.probe.unknown).toBe('unknown');
  });

  test('states the non-goals that keep it from changing production', async () => {
    const definition = await committedDefinition();
    const text = definition.nonGoals.join('\n');
    expect(text).toContain('不改变生产默认');
    expect(text).toContain('第二窗口');
    expect(text).toContain('不执行付费模型调用');
  });

  test('has a stable digest, so a record can name the definition it froze', async () => {
    const document = await committed();
    const first = digestOf(document);
    const second = digestOf(await committed());
    expect(first).toBe(second);
    expect(first.startsWith('sha256:')).toBe(true);
  });

  test('states what it does not verify', async () => {
    const definition = await committedDefinition();
    const notes = definition.notes.join('\n');
    // The decision `choice` question shape is documented but unverified against a real
    // endpoint, and the record has to say so rather than imply the probe works there.
    expect(notes).toContain('未验证');
    expect(notes).toContain('choice');
    // Nothing here ran: an input estimate is not a quality conclusion.
    expect(notes).toContain('不执行任何真实调用');
    expect(notes).toContain('null');
  });

  test('names a cache workload with a cold request and a re-use', async () => {
    const definition = await committedDefinition();
    expect(definition.cache.sequence[0]?.role).toBe('cold');
    expect(
      definition.cache.sequence.reduce((sum, slot) => sum + slot.repeats, 0),
    ).toBeGreaterThan(1);
    // Counts a provider does not report stay unknown rather than becoming zero.
    expect(definition.cache.reading).toContain('null');
  });
});
