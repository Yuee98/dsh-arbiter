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
import { definitionProblems } from '../../evals/src/experiments/inspect.js';
import type { ExperimentCell } from '../../evals/src/experiments/matrix.js';
import {
  compileExperimentCheckers,
  EXPERIMENT_SCHEMA,
} from '../../evals/src/experiments/schemas.js';
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
    budget.maxRepairRetries = 99;
    const problems = definitionProblems(definition).join('\n');
    expect(problems).toContain('cannot cover the matrix');
    expect(problems).toContain('exceeds the run');
  });
});

describe('the dry run', () => {
  test('measures every cell without writing anything', async () => {
    const io = recorder();
    const status = await planExperiment(io, DEFINITION_PATH);
    expect(status).toBe(0);
    expect(io.problems).toEqual([]);
    const printed = io.lines.join('\n');
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
    const expanded = await expandDefinition(QUIET, DEFINITION_PATH);
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
    const io = recorder();
    await planExperiment(io, DEFINITION_PATH);
    const printed = io.lines.join('\n');
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
    const expanded = await expandDefinition(QUIET, DEFINITION_PATH);
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
