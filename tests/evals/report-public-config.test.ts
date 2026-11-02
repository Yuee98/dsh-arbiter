import { describe, expect, it } from 'vitest';
import { publicWorkflowExecution } from '../../evals/src/metrics/workflow-publication.js';
import type { WorkflowExecution } from '../../evals/src/run/workflow-types.js';

function execution(config: unknown): WorkflowExecution {
  return {
    config,
    configRevision: 'actual-revision',
    codeGit: {
      root: '/synthetic',
      revision: 'a'.repeat(40),
      dirty: false,
      reason: null,
    },
    sourceGit: {
      root: null,
      revision: null,
      dirty: null,
      reason: 'Git revision or working-tree status is unavailable',
    },
  };
}
describe('public configuration projection fails closed', () => {
  it('omits arbitrary text and invalid parameters instead of substituting defaults', () => {
    const source = execution({
      context: {
        targetInputTokens: 'PRIVATE_PARAMETER',
        maxInputTokens: 0,
        projectRules: { enabled: 'PRIVATE_FLAG' },
        customRules: 'UNRECOGNIZED_PRIVATE_TEXT',
      },
      unknown: 'PRIVATE_EXTRA',
    });
    const view = publicWorkflowExecution(source, 'synthetic');
    expect(view).toMatchObject({
      configRevision: 'actual-revision',
      config: {
        redaction: 'free-text-omitted',
        context: {
          targetInputTokens: null,
          maxInputTokens: null,
          projectRules: { enabled: null },
        },
      },
    });
    expect(JSON.stringify(view)).not.toMatch(/PRIVATE_|UNRECOGNIZED/);
    expect(view.sourceGit).toEqual(source.sourceGit);
  });
  it('uses the existing credential vocabulary for adjacent provenance without publishing random marker signatures', () => {
    const secret = 'synthetic-private-token';
    const source = execution({
      context: {
        targetInputTokens: 6000,
        maxInputTokens: 10000,
        projectRules: { enabled: false },
        customRules: `Authorization: Bearer ${secret}`,
      },
    });
    const view = publicWorkflowExecution(
      {
        ...source,
        codeGit: { ...source.codeGit, reason: `failure includes ${secret}` },
      },
      'synthetic',
    );
    expect(view.codeGit.reason).toBe('[redacted]');
    expect(view.config.context).toEqual({
      targetInputTokens: 6000,
      maxInputTokens: 10000,
      projectRules: { enabled: false },
    });
    expect(JSON.stringify(view)).not.toContain(secret);
    expect(JSON.stringify(view)).not.toContain('[redacted:v1:');
  });
  it('never falls back to raw configuration when bounded credential recognition fails', () => {
    const source = execution({
      context: { customRules: 'x'.repeat(16 * 1024 * 1024 + 1) },
    });
    const view = publicWorkflowExecution(source, 'synthetic');
    expect(view).toMatchObject({
      config: {
        redaction: 'unavailable',
        context: {
          targetInputTokens: null,
          maxInputTokens: null,
          projectRules: { enabled: null },
        },
      },
      configEvidence: 'index.json#/workflowExecution/config',
    });
    expect(JSON.stringify(view)).not.toContain('xxxx');
  });
});
