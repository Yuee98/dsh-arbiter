/** The private saved execution is proof input; only a bounded public view is published. */
import { CredentialRedactor } from '../../../src/reviewer/credential-redactor.js';
import type {
  GitObservation,
  WorkflowExecution,
} from '../run/workflow-types.js';

interface PublicWorkflowConfig {
  readonly redaction: 'free-text-omitted' | 'unavailable';
  readonly context: {
    readonly targetInputTokens: number | null;
    readonly maxInputTokens: number | null;
    readonly projectRules: { readonly enabled: boolean | null };
  };
}
export interface PublicWorkflowExecution extends Omit<
  WorkflowExecution,
  'config'
> {
  readonly config: PublicWorkflowConfig;
  readonly configEvidence: 'index.json#/workflowExecution/config';
}
function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function limit(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
function safeText(value: string, redactor: CredentialRedactor): string {
  try {
    // Do not publish process-random markers: a redacted whole field stays deterministic.
    return redactor.text(value) === value ? value : '[redacted]';
  } catch {
    return '[redacted]';
  }
}
function gitView(
  source: GitObservation,
  redactor: CredentialRedactor,
): GitObservation {
  const text = (value: string | null) =>
    value === null ? null : safeText(value, redactor);
  return {
    root: text(source.root),
    revision: text(source.revision),
    dirty: source.dirty,
    reason: text(source.reason),
  };
}
export function publicWorkflowExecution(
  execution: WorkflowExecution,
  runId: string,
): PublicWorkflowExecution {
  const redactor = new CredentialRedactor(`eval-report:${runId}`);
  let cleaned: unknown = null;
  let redaction: PublicWorkflowConfig['redaction'] = 'free-text-omitted';
  try {
    cleaned = redactor.value(execution.config);
  } catch {
    // Recognition is bounded. Its failure must never fall back to the raw input.
    redaction = 'unavailable';
  }
  const context = object(object(cleaned)?.['context']);
  const project = object(context?.['projectRules']);
  return {
    config: {
      redaction,
      context: {
        targetInputTokens: limit(context?.['targetInputTokens']),
        maxInputTokens: limit(context?.['maxInputTokens']),
        projectRules: {
          enabled:
            typeof project?.['enabled'] === 'boolean'
              ? project['enabled']
              : null,
        },
      },
    },
    configEvidence: 'index.json#/workflowExecution/config',
    configRevision: safeText(execution.configRevision, redactor),
    codeGit: gitView(execution.codeGit, redactor),
    sourceGit: gitView(execution.sourceGit, redactor),
  };
}
