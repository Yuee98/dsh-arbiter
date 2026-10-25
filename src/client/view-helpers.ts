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

export function cloneDraft(config: ArbiterConfig): Draft {
  const copy = structuredClone(config);
  return {
    ...copy,
    rules: copy.rules.map((rule) => ({
      ...rule,
      match: {
        ...rule.match,
        ...(rule.match.agents === undefined
          ? {}
          : { agents: [...rule.match.agents] }),
      },
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
