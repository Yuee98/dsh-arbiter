/**
 * The run subcommands: plan, run, resume and inspect.
 *
 * The separation the issue asks for is enforced here rather than documented: nothing
 * in `pnpm verify`, `pnpm check:evals` or CI writes a run directory or reaches a
 * provider. `evals run` is the only command that dispatches, and it refuses to start
 * without a plan and, for a live plan, without a resolvable credential. Every other
 * command — including `resume` with `--dry-run` — only reads.
 *
 * The four commands also cover the two halves of the acceptance rule that "an
 * interrupted run continues without overwriting": `run --resume` continues in place,
 * and `resume --dry-run` prints exactly which cells are missing without touching a
 * file, so an operator can see the continuation before spending anything.
 */

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

import { REVIEW_CONTRACT_VERSION } from '../../../src/review-contract/index.js';
import { REVIEW_PROMPT_VERSION } from '../../../src/reviewer/contract.js';
import { USAGE_MAPPING_VERSION } from '../../../src/reviewer/usage.js';

import { datasetDigest } from '../annotation/summary.js';
import { findingOrigin, inspectDataset } from '../data/inspect.js';
import { readDataset } from '../data/read.js';
import { compileCheckers } from '../data/schemas.js';
import type { ReviewCase } from '../data/types.js';

import {
  planDigest,
  readFixture,
  readRun,
  recordPathOf,
  RUN_FILES,
  writeJson,
} from './artifact.js';
import { createRun, readExisting, resumeRun } from './lifecycle.js';
import {
  cellGrid,
  credentialRefOf,
  effectivePlan,
  planProblems,
} from './plan.js';
import { compileRunCheckers } from './schemas.js';
import type { RunCheckers } from './schemas.js';
import type { RunFixture, RunLlmLike, RunPlan, RunVersions } from './types.js';
import { RUNNER_IMPLEMENTATION_VERSION, RUN_PLAN_VERSION } from './types.js';

/** Where one command writes its human-readable output. */
export interface RunIo {
  readonly root: string;
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  /** Reads one environment variable; abstracted so a test needs no real credential. */
  readonly env?: (name: string) => string | undefined;
  /**
   * The host LLM service, when the caller has one.
   *
   * The CLI has none, so a live chat plan is refused before it writes anything. A caller
   * that does hold the service — an in-process run — passes it here and the same code
   * path becomes usable instead of silently failing every cell at the transport.
   */
  readonly llm?: RunLlmLike;
}

/** What `run` was asked to do. */
export interface RunCommand {
  readonly planPath: string;
  readonly directory: string | null;
  readonly resume: boolean;
  readonly dryRun: boolean;
  /** The caller's lifetime, supplied by the entry point. */
  readonly signal: AbortSignal;
}

/** The versions every record of this build carries. */
export function versionsFor(plan: RunPlan): RunVersions {
  return {
    contract: REVIEW_CONTRACT_VERSION,
    prompt: REVIEW_PROMPT_VERSION,
    usageMapping: USAGE_MAPPING_VERSION,
    plan: plan.planVersion,
    artifact: 'eval-run-artifact-v1',
    implementation: RUNNER_IMPLEMENTATION_VERSION,
    node: process.versions.node,
  };
}

/** A non-array object, for narrowing a parsed document without asserting its type. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** One dataset's cases and digest, checked before a plan is resolved against it. */
interface LoadedDataset {
  readonly cases: readonly ReviewCase[];
  readonly digest: string;
  readonly datasetId: string;
  /** Problems with this dataset's labels, which a run reports but does not obey. */
  readonly labelProblems: readonly string[];
}

/**
 * Read and validate one dataset, or say what is wrong with it.
 *
 * The rubric version comes from the committed snapshot, not from the plan: a run reads
 * the same document the annotation tools do, so a plan cannot declare a semantics the
 * repository does not publish. Only problems that make the data unusable block a run;
 * a stale *label* does not, because a run reads cases and never labels.
 */
async function loadDataset(
  io: RunIo,
  datasetPath: string,
): Promise<
  | { readonly ok: true; readonly dataset: LoadedDataset }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  const checkers = await compileCheckers();
  let rubric: unknown;
  try {
    rubric = JSON.parse(
      await readFile(resolve(io.root, 'evals/rubrics/rubric-v1.json'), 'utf8'),
    ) as unknown;
  } catch {
    return {
      ok: false,
      problems: ['evals/rubrics/rubric-v1.json is not readable JSON'],
    };
  }
  const rubricVersion = isRecord(rubric) ? rubric['rubricVersion'] : null;
  if (typeof rubricVersion !== 'string') {
    return {
      ok: false,
      problems: ['evals/rubrics/rubric-v1.json declares no rubricVersion'],
    };
  }
  const raw = await readDataset(resolve(io.root, datasetPath));
  const inspection = inspectDataset(raw, checkers, {
    contract: REVIEW_CONTRACT_VERSION,
    rubric: rubricVersion,
  });
  // Only a problem with the dataset *itself* blocks a run. A stale label is a problem
  // with the annotation side: its input hash no longer matches the case, which a run reads
  // and never touches. Rejecting the run for it would mean revised case inputs could not
  // be evaluated until someone re-adjudicated labels that play no part in the execution —
  // and the annotation tools are where that belongs.
  const blocking = inspection.problems.filter(
    (problem) => findingOrigin(problem) !== 'label',
  );
  if (blocking.length > 0) {
    return {
      ok: false,
      problems: blocking.map(
        (problem) => `${problem.path}: ${problem.message}`,
      ),
    };
  }
  const manifest = inspection.manifest;
  if (manifest === null) {
    return { ok: false, problems: [`${datasetPath} has no manifest`] };
  }
  return {
    ok: true,
    dataset: {
      cases: inspection.cases.map((entry) => entry.document),
      digest: datasetDigest(inspection),
      datasetId: manifest.datasetId,
      // The label problems are carried rather than dropped: a run should not fail for them,
      // but a plan that names a dataset whose labels are stale is worth saying out loud.
      labelProblems: inspection.problems
        .filter((problem) => findingOrigin(problem) === 'label')
        .map((problem) => `${problem.path}: ${problem.message}`),
    },
  };
}

/**
 * Why a plan cannot be run against the dataset it points at.
 *
 * The plan names a `datasetId` and a `datasetPath`, and the two can disagree: a copied or
 * misconfigured plan would then place one dataset's cases under another's identity in the
 * artifact, and a report would attribute the results to the wrong dataset. The manifest is
 * the authority for what a directory is, so a mismatch is refused before anything expands.
 *
 * Label problems are reported here too, without blocking: a run reads cases and never
 * labels, so a stale annotation is worth saying but is not this command's business to fix.
 */
function datasetProblems(
  io: RunIo,
  plan: RunPlan,
  dataset: LoadedDataset,
): void {
  if (dataset.datasetId !== plan.datasetId) {
    io.err(
      `problem the plan names dataset ${plan.datasetId} but ${plan.datasetPath} declares itself ${dataset.datasetId}; a run cannot be attributed to a dataset it did not read`,
    );
  }
  for (const problem of dataset.labelProblems) {
    io.err(
      `note this dataset has a label problem a run does not depend on: ${problem}`,
    );
  }
}

/** Read one plan document, or say why it is not a plan. */
async function readPlan(
  checkers: RunCheckers,
  path: string,
): Promise<
  | { readonly ok: true; readonly plan: RunPlan }
  | { readonly ok: false; readonly problems: readonly string[] }
> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    return {
      ok: false,
      problems: [
        error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? `${path} does not exist`
          : `${path} is not readable JSON`,
      ],
    };
  }
  const checked = checkers.plan(raw);
  if (!checked.ok) {
    return {
      ok: false,
      problems: checked.problems.map((problem) => `${path}: ${problem}`),
    };
  }
  return { ok: true, plan: checked.document };
}

/**
 * The case ids a plan names that its dataset does not publish.
 *
 * A plan may name its cases explicitly or let the split choose. Only the explicit form
 * can be wrong, and a wrong id must be refused rather than silently dropped: a run that
 * quietly skipped a case would report a smaller experiment than it was asked for.
 */
export function unknownCaseIds(
  plan: RunPlan,
  cases: readonly ReviewCase[],
): readonly string[] {
  const named = plan.caseIds ?? [];
  if (named.length === 0) return [];
  const published = new Set(cases.map((entry) => entry.caseId));
  return named.filter((caseId) => !published.has(caseId));
}

/**
 * Resolve the cases a plan selects, in the order the plan asked for.
 *
 * The split is applied here, once: a plan that names `caseIds` keeps them, and a plan
 * that names only a split gets the split's cases in manifest order. Resolving at run
 * start is what freezes the selection, so a later commit that adds a case cannot enlarge a
 * run already in progress.
 *
 * An explicit list is resolved in *its own* order, not the dataset's. When the attempt
 * budget only covers part of the selection, the order decides which cells actually run, so
 * silently reordering would execute a different experiment from the one the plan declared.
 */
export function resolveCases(
  plan: RunPlan,
  cases: readonly ReviewCase[],
): readonly ReviewCase[] {
  const named = plan.caseIds ?? [];
  if (named.length > 0) {
    const byId = new Map(cases.map((entry) => [entry.caseId, entry] as const));
    return named.flatMap((caseId) => {
      const entry = byId.get(caseId);
      return entry === undefined ? [] : [entry];
    });
  }
  if (plan.split === 'all') return cases;
  return cases.filter((entry) => entry.split === plan.split);
}

/**
/**
 * Where a plan's fixture lives.
 *
 * The published schema says the path is relative to the plan document, so that is what
 * this does: a plan and its fixture can be moved together and keep working. Resolving
 * against the repository root instead would reject a portable plan that the schema
 * accepts, and would make the contract the schema publishes untrue.
 */
function fixturePathOf(planPath: string, fixture: string): string {
  return isAbsolute(fixture) ? fixture : resolve(dirname(planPath), fixture);
}

/**
 * `run --dry-run`: expand a plan and report what it would do.
 *
 * This is the offline half of the runner, and the only half `pnpm verify` can use. It
 * builds every cell, states which pairings are unsupported, and prints the fixtures it
 * found — without dispatching anything. A dry run that would dispatch is not a dry
 * run, so no backend is ever constructed here.
 */
export async function planRun(io: RunIo, command: RunCommand): Promise<number> {
  const checkers = await compileRunCheckers();
  const read = await readPlan(checkers, resolve(io.root, command.planPath));
  if (!read.ok) {
    for (const problem of read.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const plan = read.plan;
  // The selection is judged after the split is resolved, so the earlier pass skips it.
  const problems = planProblems(plan, { selectionKnown: false });
  if (problems.length > 0) {
    for (const problem of problems) io.err(`problem ${problem}`);
    return 1;
  }
  // The dataset is checked after the plan's own declarations, because a plan that
  // cannot mean what it says is a problem no dataset can fix. Both refusals name what
  // is wrong instead of reporting a generic failure.
  const dataset = await loadDataset(io, plan.datasetPath);
  if (!dataset.ok) {
    for (const problem of dataset.problems) io.err(`problem ${problem}`);
    return 1;
  }
  if (dataset.dataset.datasetId !== plan.datasetId) {
    datasetProblems(io, plan, dataset.dataset);
    return 1;
  }
  datasetProblems(io, plan, dataset.dataset);
  const unknown = unknownCaseIds(plan, dataset.dataset.cases);
  if (unknown.length > 0) {
    // A run that quietly skipped a case would report a smaller experiment than it was
    // asked for, so an unpublished id is refused instead of dropped.
    io.err(
      `problem the plan names ${String(unknown.length)} case(s) this dataset does not publish: ${unknown.join(', ')}`,
    );
    return 1;
  }
  const resolvedCases = resolveCases(plan, dataset.dataset.cases);
  const selectionProblems = planProblems(plan, {
    resolvedCases: resolvedCases.length,
  });
  if (selectionProblems.length > 0) {
    for (const problem of selectionProblems) io.err(`problem ${problem}`);
    return 1;
  }
  const resolvedPlan = withResolvedCases(plan, resolvedCases);
  const grid = cellGrid(resolvedPlan);
  io.out(
    `plan ${plan.datasetId} split ${plan.split}: ${String(resolvedPlan.caseIds?.length ?? 0)} cases`,
  );
  io.out(
    `targets ${String(plan.targets.length)}, protocols ${plan.protocols.join('+')}, repeats ${String(plan.repeats)}`,
  );
  io.out(
    `cells ${String(grid.cells.length)}: ${String(grid.supported)} supported, ${String(grid.unsupported)} unsupported`,
  );
  io.out(
    `bounds concurrency ${String(plan.bounds.concurrency)}, timeoutMs ${String(plan.bounds.timeoutMs)}, maxAttempts ${String(plan.bounds.maxAttempts)}, maxInputTokens ${String(plan.bounds.maxInputTokens)}`,
  );
  io.out(`transport ${plan.transport}`);
  if (plan.fixture !== null) {
    const fixture = await readFixture(
      fixturePathOf(resolve(io.root, command.planPath), plan.fixture),
      checkers,
    );
    if (!fixture.ok) {
      io.err(`problem ${fixture.message}`);
      return 1;
    }
    const scripted = fixture.fixture.cells;
    for (const cell of grid.cells) {
      if (!cell.supported) continue;
      const entry = scripted[cell.cellId];
      if (entry === undefined) {
        io.err(
          `problem fixture has no entry for ${cell.cellId}; a cell without a script cannot be replayed`,
        );
        return 1;
      }
    }
    io.out(
      `fixture ${plan.fixture}: ${String(Object.keys(scripted).length)} scripted cells`,
    );
  }
  if (plan.transport === 'live') {
    // A dry run of a live plan names what it would need, and does not read it: an
    // environment probe is not a credential check, and reporting a missing one as a
    // plan error would make a dry run fail on a machine that is not the runner.
    // Only a selected protocol can make a credential matter. A dual-configured target whose
    // unused decision section declares a second reference is not a problem for a chat-only
    // plan, and refusing it would gate the plan on a section it never invokes — the same
    // boundary the execution preflight already respects.
    const selected = plan.protocols;
    for (const target of plan.targets) {
      if (selected.includes('decision') && target.decision !== null) {
        const resolved = credentialRefOf(target);
        if (!resolved.ok) {
          io.err(`problem ${resolved.message}`);
          return 1;
        }
        if (resolved.ref.length === 0) continue;
        io.out(
          `live target ${target.targetId} resolves decision credential ${resolved.ref} from the environment at dispatch`,
        );
        continue;
      }
      if (selected.includes('chat') && target.chat !== null) {
        // A chat cell needs a route and a service, not a credential reference; naming one
        // here would assert a requirement the transport does not have.
        io.out(
          `live target ${target.targetId} routes chat through ${target.chat.provider}/${target.chat.model} at dispatch`,
        );
      }
    }
  }
  io.out(`planHash ${planDigest(resolvedPlan)}`);
  for (const cell of grid.cells) {
    if (cell.supported) continue;
    io.out(`unsupported ${cell.cellId}: ${cell.unsupportedReason ?? ''}`);
  }
  return 0;
}

/** The plan with its cases resolved, which is what a run freezes and hashes. */
function withResolvedCases(
  plan: RunPlan,
  cases: readonly ReviewCase[],
): RunPlan {
  return effectivePlan(
    plan,
    cases.map((entry) => entry.caseId),
  );
}

/**
 * `run`: create a run directory and dispatch its cells.
 *
 * The order is deliberate: the directory and its index exist before the first cell, so
 * an interrupted run is still described by its own files. A live dispatch requires a
 * credential, and a missing one refuses the whole run *before* any cell is written:
 * starting a live run with no credential would produce a directory full of identical
 * failures that look like provider outages.
 */
export async function executeRun(
  io: RunIo,
  command: RunCommand,
): Promise<number> {
  const checkers = await compileRunCheckers();
  const read = await readPlan(checkers, resolve(io.root, command.planPath));
  if (!read.ok) {
    for (const problem of read.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const plan = read.plan;
  const planIssues = planProblems(plan, { selectionKnown: false });
  if (planIssues.length > 0) {
    for (const problem of planIssues) io.err(`problem ${problem}`);
    return 1;
  }
  const dataset = await loadDataset(io, plan.datasetPath);
  if (!dataset.ok) {
    for (const problem of dataset.problems) io.err(`problem ${problem}`);
    return 1;
  }
  if (dataset.dataset.datasetId !== plan.datasetId) {
    datasetProblems(io, plan, dataset.dataset);
    return 1;
  }
  datasetProblems(io, plan, dataset.dataset);
  const unknown = unknownCaseIds(plan, dataset.dataset.cases);
  if (unknown.length > 0) {
    io.err(
      `problem the plan names ${String(unknown.length)} case(s) this dataset does not publish: ${unknown.join(', ')}`,
    );
    return 1;
  }
  const cases = resolveCases(plan, dataset.dataset.cases);
  const selectionProblems = planProblems(plan, { resolvedCases: cases.length });
  if (selectionProblems.length > 0) {
    for (const problem of selectionProblems) io.err(`problem ${problem}`);
    return 1;
  }
  const resolvedPlan = withResolvedCases(plan, cases);
  if (command.dryRun) {
    return planRun(io, command);
  }
  const env = io.env ?? ((name: string) => process.env[name]);
  if (resolvedPlan.transport === 'live') {
    // A live cell needs a route it can actually take. Both reasons are checked before the
    // directory is created, because a run that starts and then fails every cell produces
    // a directory full of identical failures that look like provider outages.
    const unroutable = liveProblems(resolvedPlan, io.llm ?? null, env);
    if (unroutable.length > 0) {
      for (const problem of unroutable) io.err(`problem ${problem}`);
      return 1;
    }
  }
  let fixture: RunFixture | null = null;
  if (resolvedPlan.fixture !== null) {
    const loaded = await readFixture(
      fixturePathOf(resolve(io.root, command.planPath), resolvedPlan.fixture),
      checkers,
    );
    if (!loaded.ok) {
      io.err(`problem ${loaded.message}`);
      return 1;
    }
    fixture = loaded.fixture;
  }
  const directory = resolve(
    io.root,
    command.directory ??
      defaultRunDirectory(resolvedPlan.datasetId, command.planPath),
  );
  const versions = versionsFor(resolvedPlan);
  const now = (): number => Date.now();
  const runId = runIdOf(resolvedPlan, planDigest(resolvedPlan));
  if (command.resume) {
    const existing = await readExisting(
      directory,
      resolvedPlan,
      checkers,
      dataset.dataset.digest,
    );
    if (!existing.ok) {
      for (const problem of existing.problems) io.err(`problem ${problem}`);
      return 1;
    }
    const outcome = await guardedResume(io, {
      directory,
      existing: existing.existing,
      cases,
      fixture: fixture ?? {
        fixtureVersion: 'eval-offline-fixture-v1',
        description: '',
        cells: {},
        notes: [],
      },
      versions,
      checkers,
      llm: io.llm ?? null,
      readCredential: env,
      signal: command.signal,
      // Only this branch continues an existing run; the first pass below is a new one.
      continuation: true,
      now,
    });
    if (outcome === null) return 1;
    reportRun(io, directory, outcome.index.status, outcome.index.spent);
    return outcome.index.status === 'complete' ? 0 : 1;
  }
  // An occupied destination is refused before either document is published. Continuing
  // an experiment is `--resume`, which checks the plan hash; a second `run` into the same
  // directory would replace the frozen plan and index while leaving the old records in
  // place, producing a directory that describes two experiments at once.
  await mkdir(directory, { recursive: true });
  const occupied = await occupiedRun(directory);
  if (occupied !== null) {
    io.err(
      `problem ${directory} already holds ${occupied}; refusing to overwrite it. Use --resume to continue that run, or --dir to name a new one`,
    );
    return 1;
  }
  const created = await createRun({
    directory,
    runId,
    plan: resolvedPlan,
    cases,
    datasetDigest: dataset.dataset.digest,
    versions,
    now,
  });
  if (!created.ok) {
    for (const problem of created.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const outcome = await guardedResume(io, {
    directory,
    existing: { index: created.index, records: [] },
    cases,
    fixture: fixture ?? {
      fixtureVersion: 'eval-offline-fixture-v1',
      description: '',
      cells: {},
      notes: [],
    },
    versions,
    checkers,
    llm: io.llm ?? null,
    readCredential: env,
    signal: command.signal,
    continuation: false,
    now,
  });
  if (outcome === null) return 1;
  reportRun(io, directory, outcome.index.status, outcome.index.spent);
  return outcome.index.status === 'complete' ? 0 : 1;
}

/**
 * Whether a directory already holds a run, and which document proves it.
 *
 * Both documents are checked rather than only the index: a directory someone emptied by
 * hand is a fresh destination, while one holding either file is somebody's run.
 */
async function occupiedRun(directory: string): Promise<string | null> {
  for (const name of [RUN_FILES.index, RUN_FILES.plan]) {
    const present = await readFile(resolve(directory, name), 'utf8').then(
      () => true,
      () => false,
    );
    if (present) return name;
  }
  return null;
}

/**
 * Why a live plan cannot dispatch, before anything is written.
 *
 * A chat cell needs an LLM service to stream through; this command has none, so a live
 * chat target is refused here with the reason rather than at the transport, where it
 * would surface as one failed cell per scripted call. A decision cell needs its
 * credential. `provider: "session"` is refused for the same reason production refuses it:
 * there is no host session in a headless run.
 */
export function liveProblems(
  plan: RunPlan,
  llm: RunLlmLike | null,
  env: (name: string) => string | undefined,
): readonly string[] {
  const problems: string[] = [];
  // Only a *selected* protocol can make a target unroutable. A dual-protocol target whose
  // unused chat section names the session provider is not a problem for a decision-only
  // plan, and refusing it would block a run for a section it never touches.
  const chats = plan.protocols.includes('chat');
  const decisions = plan.protocols.includes('decision');
  const chatTargets = chats
    ? plan.targets.filter((target) => target.chat !== null)
    : [];
  const decisionTargets = decisions
    ? plan.targets.filter((target) => target.decision !== null)
    : [];
  if (chatTargets.length > 0 && llm === null) {
    problems.push(
      'a live chat cell needs the host LLM service, which this command does not have; run a chat plan offline, or reach a chat model through a decision endpoint',
    );
  }
  for (const target of chatTargets) {
    if (target.chat?.provider === 'session') {
      problems.push(
        `target ${target.targetId} asks for provider "session", which no headless run has`,
      );
    }
  }
  if (decisionTargets.length > 0) {
    for (const target of decisionTargets) {
      const resolved = credentialRefOf(target);
      if (!resolved.ok) {
        problems.push(resolved.message);
        continue;
      }
      // The preflight and the dispatch resolve the same value, so passing here means the
      // transport will find the same variable rather than a sibling that was never set.
      if ((env(resolved.ref) ?? '').length === 0) {
        problems.push(
          `a live run needs ${resolved.ref}; refusing to start without it`,
        );
      }
    }
  }
  return problems;
}

/**
 * Run one dispatch, reporting a refusal as a command problem rather than a crash.
 *
 * A continuation can be refused for reasons the operator can act on — another process
 * holds the run claim, a request may still be outstanding, the versions moved. Those are
 * failures of this command, not defects of this program, so they belong on stderr with an
 * exit code rather than as an unhandled rejection.
 */
async function guardedResume(
  io: RunIo,
  options: Parameters<typeof resumeRun>[0],
): Promise<Awaited<ReturnType<typeof resumeRun>> | null> {
  try {
    return await resumeRun(options);
  } catch (error) {
    if (error instanceof Error) {
      io.err(`problem ${error.message}`);
      return null;
    }
    throw error;
  }
}

/** The default directory one run writes into, outside version control. */
export function defaultRunDirectory(
  datasetId: string,
  planPath: string,
): string {
  const base = planPath.split('/').pop() ?? 'plan';
  const name = base.replace(/\.json$/u, '');
  return `.local/evals/runs/${datasetId}/${name}`;
}

/** A run's identifier, derived from the plan so two runs of one plan share it. */
export function runIdOf(plan: RunPlan, hash: string): string {
  const suffix = hash.replace('sha256:', '').slice(0, 12);
  return `${plan.datasetId}-${suffix}`;
}

/** Print one run's summary. */
function reportRun(
  io: RunIo,
  directory: string,
  status: string,
  spent: {
    readonly cellsStarted: number;
    readonly cellsCompleted: number;
    readonly cellsPlanned: number;
    readonly attempts: number;
  },
): void {
  io.out(
    `run ${directory}: ${status} — ${String(spent.cellsCompleted)}/${String(spent.cellsPlanned)} cells decided, ${String(spent.cellsStarted)} started, ${String(spent.attempts)} attempts`,
  );
}

/**
 * `resume --dry-run`: report which cells are missing, and touch nothing.
 *
 * This is the offline way to see a continuation. It reads the index and the records,
 * and prints the cells that have none; it never constructs a backend, so it cannot
 * spend anything by accident.
 */
export async function inspectResume(
  io: RunIo,
  command: RunCommand,
): Promise<number> {
  const checkers = await compileRunCheckers();
  const read = await readPlan(checkers, resolve(io.root, command.planPath));
  if (!read.ok) {
    for (const problem of read.problems) io.err(`problem ${problem}`);
    return 1;
  }
  // The comparison has to be against the plan a run would freeze, not the authored
  // document: a plan that omits `caseIds` resolves to a different value, and comparing the
  // raw form would report a legitimate continuation as a drifted plan.
  const problems = planProblems(read.plan, { selectionKnown: false });
  if (problems.length > 0) {
    for (const problem of problems) io.err(`problem ${problem}`);
    return 1;
  }
  const dataset = await loadDataset(io, read.plan.datasetPath);
  if (!dataset.ok) {
    for (const problem of dataset.problems) io.err(`problem ${problem}`);
    return 1;
  }
  if (dataset.dataset.datasetId !== read.plan.datasetId) {
    datasetProblems(io, read.plan, dataset.dataset);
    return 1;
  }
  datasetProblems(io, read.plan, dataset.dataset);
  const unknown = unknownCaseIds(read.plan, dataset.dataset.cases);
  if (unknown.length > 0) {
    io.err(
      `problem the plan names ${String(unknown.length)} case(s) this dataset does not publish: ${unknown.join(', ')}`,
    );
    return 1;
  }
  const resolvedPlan = withResolvedCases(
    read.plan,
    resolveCases(read.plan, dataset.dataset.cases),
  );
  const directory = resolve(
    io.root,
    command.directory ??
      defaultRunDirectory(resolvedPlan.datasetId, command.planPath),
  );
  const existing = await readExisting(
    directory,
    resolvedPlan,
    checkers,
    dataset.dataset.digest,
  );
  if (!existing.ok) {
    for (const problem of existing.problems) io.err(`problem ${problem}`);
    return 1;
  }
  const done = new Set(
    existing.existing.records.map((record) => record.cellId),
  );
  const grid = cellGrid(existing.existing.index.plan);
  const pending = grid.cells.filter((cell) => !done.has(cell.cellId));
  io.out(
    `run ${directory}: ${String(done.size)}/${String(grid.cells.length)} cells have a record, ${String(pending.length)} pending`,
  );
  for (const cell of pending) {
    io.out(`pending ${cell.cellId}`);
  }
  io.out(`status ${existing.existing.index.status}`);
  return 0;
}

/**
 * `show`: read one finished run and print what it holds.
 *
 * This is the offline consumer path a report uses: it reads the written records through
 * the published schemas and prints the per-cell outcome and usage coverage. It performs
 * no requests, and it reads the same documents `readRun` exposes to #75.
 */
export async function showRun(io: RunIo, directory: string): Promise<number> {
  const checkers = await compileRunCheckers();
  const read = await readRun(resolve(io.root, directory), checkers);
  if (!read.ok) {
    for (const problem of read.problems) {
      io.err(`problem ${problem.path}: ${problem.message}`);
    }
    return 1;
  }
  const { index, records, missing } = read.artifact;
  io.out(`run ${index.runId} (${index.status}) plan ${index.planHash}`);
  io.out(
    `dataset ${index.dataset.datasetId} ${index.dataset.digest} — ${String(index.dataset.caseCount)} cases`,
  );
  io.out(
    `versions contract ${index.versions.contract}, prompt ${index.versions.prompt}, usage ${index.versions.usageMapping}`,
  );
  for (const record of records) {
    const outcome = record.outcome;
    const verdict =
      outcome === null
        ? record.status
        : outcome.status === 'scored'
          ? `${outcome.status} ${String(outcome.risk)}/${String(outcome.authorization)} ${outcome.verdict}`
          : outcome.status;
    io.out(
      `cell ${record.cellId}: ${record.status} ${verdict} attempts ${String(record.attempts.length)}`,
    );
    if (record.usage !== null) {
      io.out(
        `  usage ${record.usage.mappingVersion}: ${String(record.usage.attempts)} attempts, ${String(record.usage.withUsage)} with usage`,
      );
    }
  }
  for (const cell of missing) {
    io.err(
      `problem ${cell.record}: this run planned the cell but never wrote it`,
    );
  }
  return missing.length === 0 ? 0 : 1;
}

/** The path a run directory keeps its records under, for a caller that needs it. */
export function recordsDirectoryOf(directory: string): string {
  return `${directory}/${RUN_FILES.records}`;
}

/** Where one cell's record lives, for a caller that reads a single cell. */
export function recordOf(cellId: string): string {
  return recordPathOf(cellId);
}

/** Write one plan document, so a caller can author a plan from a command. */
export async function writePlan(path: string, plan: RunPlan): Promise<void> {
  await writeJson(path, { ...plan, planVersion: RUN_PLAN_VERSION });
}
