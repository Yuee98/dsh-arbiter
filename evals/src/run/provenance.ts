import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { stableHash } from '../../../src/config.js';
import { canonicalJson } from '../data/hash.js';
import { effectiveWorkflowConfig, isWorkflowSource } from './source.js';
import type { RunSource } from './source.js';
import type { RunPlan } from './types.js';
import type { GitObservation, WorkflowExecution } from './workflow-types.js';

const execute = promisify(execFile);
const codeDirectory = fileURLToPath(new URL('../../../', import.meta.url));

export async function legacyRunProvenance(): Promise<{
  readonly codeGit: GitObservation;
}> {
  return { codeGit: await observeGit(codeDirectory) };
}

/** Read-only provenance; an unavailable repository is unknown, never a fake SHA. */
export async function observeGit(
  directory: string,
  trackedPaths?: readonly string[],
): Promise<GitObservation> {
  try {
    const git = async (args: readonly string[]): Promise<string> =>
      (
        await execute('git', ['-C', directory, ...args], {
          maxBuffer: 1024 * 1024,
        })
      ).stdout.trim();
    const root = await git(['rev-parse', '--show-toplevel']);
    const revision = await git(['rev-parse', 'HEAD']);
    const status = await git(['status', '--porcelain']);
    if (trackedPaths !== undefined) {
      try {
        await git(['ls-files', '--error-unmatch', '--', ...trackedPaths]);
      } catch {
        return {
          root,
          revision: null,
          dirty: true,
          reason: 'selected workflow sources are outside the tracked revision',
        };
      }
    }
    return { root, revision, dirty: status.length > 0, reason: null };
  } catch {
    return {
      root: null,
      revision: null,
      dirty: null,
      reason: 'Git revision or working-tree status is unavailable',
    };
  }
}

export async function workflowExecutionOf(
  plan: RunPlan,
  sources: readonly RunSource[],
): Promise<WorkflowExecution> {
  const source = sources.find(isWorkflowSource);
  if (source === undefined) throw new Error('workflow has no execution source');
  const config = effectiveWorkflowConfig(plan);
  const [codeGit, sourceGit] = await Promise.all([
    observeGit(codeDirectory),
    observeGit(source.directory, [
      ...new Set(
        sources
          .filter(isWorkflowSource)
          .map(
            (entry) => `${entry.split}/${entry.workflow.group}/workflows.json`,
          ),
      ),
    ]),
  ]);
  return {
    config,
    configRevision: stableHash(canonicalJson(config)),
    codeGit,
    sourceGit,
  };
}

export function executionProblems(
  recorded: WorkflowExecution | undefined,
  current: WorkflowExecution,
): readonly string[] {
  if (recorded === undefined)
    return ['workflow execution configuration/provenance is missing'];
  const problems: string[] = [];
  if (
    recorded.configRevision !== current.configRevision ||
    canonicalJson(recorded.config) !== canonicalJson(current.config)
  )
    problems.push('workflow effective configuration moved');
  for (const key of ['codeGit', 'sourceGit'] as const) {
    const before = recorded[key];
    const after = current[key];
    if (
      before.revision !== null &&
      after.revision !== null &&
      before.revision !== after.revision
    )
      problems.push(`${key} revision moved`);
    if (
      before.dirty !== null &&
      after.dirty !== null &&
      before.dirty !== after.dirty
    )
      problems.push(`${key} working-tree state moved`);
  }
  return problems;
}
