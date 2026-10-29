import { ApiError } from './api.js';
import type { ArbiterConfig } from '../types.js';
import type { Draft } from './view-types.js';
import type { ConfigIssueView } from './view-issues.js';

/** Decode only the documented issue shape; unknown entries are dropped. */
export function configErrors(payload: unknown): readonly ConfigIssueView[] {
  if (
    payload === null ||
    typeof payload !== 'object' ||
    !('errors' in payload) ||
    !Array.isArray(payload.errors)
  )
    return [];
  const errors: readonly unknown[] = payload.errors;
  return errors.filter(
    (item): item is ConfigIssueView =>
      item !== null &&
      typeof item === 'object' &&
      'path' in item &&
      typeof item.path === 'string' &&
      'message' in item &&
      typeof item.message === 'string',
  );
}

/**
 * A request failure's developer text.
 *
 * Issue sentences are localized where they are rendered, so this keeps the
 * transport message and the machine paths only.
 */
export function errorText(error: unknown): string {
  if (error instanceof ApiError) {
    const errors = configErrors(error.payload);
    if (errors.length > 0)
      return `${error.message}: ${errors.map((item) => item.path).join('; ')}`;
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

export function formatTime(ts: number): string {
  if (ts === 0) return '—';
  return new Date(ts).toLocaleString();
}

/**
 * The one format id this build reads, mirrored for the browser bundle.
 *
 * Server code cannot be imported here, so the id is repeated; a drift is caught by
 * behaviour rather than by this comment, because a draft carrying the wrong
 * declaration is rejected by the save path's format check.
 */
export const DRAFT_FORMAT = 'arbiter-config-v3';

/**
 * A draft of the effective configuration.
 *
 * The draft declares the current format whenever it carries rules, so a saved
 * document states the rule model it was written for. A draft without rules keeps
 * whatever the document declared, so an explicit declaration still round-trips
 * unchanged.
 */
export function cloneDraft(config: ArbiterConfig): Draft {
  const copy = structuredClone(config);
  return {
    ...copy,
    ...(copy.rules.length === 0 ? {} : { format: DRAFT_FORMAT }),
    rules: copy.rules.map((rule) => ({
      ...rule,
      // The rule already carries its own connective; the spread keeps it. A rule
      // that somehow lost it would still be written without one, and the server
      // rejects rather than guesses.
      conditions: rule.conditions.map((condition) => ({ ...condition })),
      ...(rule.scope === undefined
        ? {}
        : {
            scope: {
              ...(rule.scope.tools === undefined
                ? {}
                : { tools: [...rule.scope.tools] }),
              ...(rule.scope.agents === undefined
                ? {}
                : { agents: [...rule.scope.agents] }),
            },
          }),
    })),
    context: {
      ...copy.context,
      projectRules: {
        ...copy.context.projectRules,
        files: [...copy.context.projectRules.files],
      },
    },
  };
}
