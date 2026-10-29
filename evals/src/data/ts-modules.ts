/**
 * How the evals runtime loads the shared contract.
 *
 * The root project is `module: NodeNext`, so every internal import names the
 * emitted `.js` file (`./rubrics.js`). That is right for the build and for Vitest,
 * which maps the specifier back to source. Node itself has no such mapping, so the
 * evals CLI cannot import `src/review-contract/` from source without help.
 *
 * The CLI registers this resolution at start-up and imports the shared contract
 * from `src/`, never from `lib/`: `lib/` is a build artifact a fresh checkout does
 * not have, and a check that silently graded a stale build would be worse than one
 * that refused to run. Production never loads this module; it exists so the evals
 * subproject can call the one scoring implementation instead of copying it.
 */

import { existsSync } from 'node:fs';
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';

import type { ResolveFnOutput, ResolveHookContext } from 'node:module';

/**
 * The `.ts` sibling of a `.js` specifier, or null when there is none.
 *
 * Only a relative `.js` specifier is considered, so a bare package import, a URL
 * or a genuinely JavaScript file is left exactly as it was.
 */
export function typescriptSibling(
  specifier: string,
  parentURL: string | undefined,
): string | null {
  if (parentURL === undefined) return null;
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  if (!specifier.endsWith('.js')) return null;
  let candidate: URL;
  try {
    candidate = new URL(`${specifier.slice(0, -3)}.ts`, parentURL);
  } catch {
    return null;
  }
  if (candidate.protocol !== 'file:') return null;
  return existsSync(fileURLToPath(candidate)) ? candidate.href : null;
}

/** Resolve one specifier, rewriting a relative `.js` to its `.ts` sibling. */
function resolveHook(
  specifier: string,
  context: ResolveHookContext,
  nextResolve: (
    specifier: string,
    context?: Partial<ResolveHookContext>,
  ) => ResolveFnOutput,
): ResolveFnOutput {
  const sibling = typescriptSibling(specifier, context.parentURL);
  if (sibling !== null) return { url: sibling, shortCircuit: true };
  return nextResolve(specifier, context);
}

let installed = false;

/** Register the sibling resolution for this process. Safe to call twice. */
export function installTypeScriptSiblings(): void {
  if (installed) return;
  registerHooks({ resolve: resolveHook });
  installed = true;
}
