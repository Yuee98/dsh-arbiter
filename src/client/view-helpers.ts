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
 * The canonical rule format id.
 *
 * A draft holds the canonical rule structure. Saving rules therefore has to
 * declare that format: without it the document would be read as the legacy
 * format and its `conditions` rules rejected — including when the user only
 * changed an unrelated setting on a document that still used the old rules.
 * A draft without rules keeps whatever the document declared, so an explicit
 * declaration still round-trips unchanged.
 */
const CANONICAL_FORMAT = 'arbiter-config-v2';

export function cloneDraft(config: ArbiterConfig): Draft {
  const copy = structuredClone(config);
  return {
    ...copy,
    ...(copy.rules.length === 0 ? {} : { format: CANONICAL_FORMAT }),
    rules: copy.rules.map((rule) => ({
      ...rule,
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
