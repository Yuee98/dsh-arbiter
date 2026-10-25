import type { CallResult, PreToolDecision, SessionKind } from '../types.js';
import type { AgentLike } from '../snapshot.js';
import type { ContextLike } from './types.js';

export function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function sessionKindOf(agent: AgentLike): SessionKind {
  const header = agent.session.header;
  if (header?.origin === 'subagent' || header?.parentSession !== undefined)
    return 'subagent';
  return 'main';
}

export function deny(reason: string): PreToolDecision {
  return {
    kind: 'deny',
    reason,
    info: {
      name: 'ArbiterDeniedError',
      code: 'ARBITER_DENIED',
      reason,
    },
  };
}

const CALL_RESULTS: readonly CallResult[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
  'review-allow',
  'review-deny',
  'review-escalate',
  'human-allow',
  'human-deny',
  'human-abort',
  'fallback-deny',
];

export function asCallResult(value: unknown): CallResult | null {
  return typeof value === 'string'
    ? (CALL_RESULTS.find((entry) => entry === value) ?? null)
    : null;
}

export function executionModeName(ctx: ContextLike): string {
  const policy = ctx.get('sandboxPolicy');
  return policy?.defaultMode === 'danger-full-access' ? 'trusted' : 'guarded';
}
