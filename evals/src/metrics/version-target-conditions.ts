/** Compare private frozen execution settings; publish only controlled difference categories. */
import { canonicalJson } from '../data/hash.js';
import type { RunPlan, RunTarget } from '../run/types.js';
import type { CellFacts } from './cell.js';

function route(target: RunTarget, protocol: CellFacts['protocol']): object {
  return protocol === 'chat'
    ? {
        credentialRef: target.credentialRef,
        provider: target.chat?.provider ?? null,
        model: target.chat?.model ?? null,
      }
    : {
        credentialRef: target.credentialRef,
        url: target.decision?.url ?? null,
        apiKeyRef: target.decision?.apiKeyRef ?? null,
        model: target.decision?.model ?? null,
      };
}
function settings(
  target: RunTarget,
  protocol: CellFacts['protocol'],
): object | null {
  if (protocol === 'decision')
    return target.decision === null
      ? null
      : { timeoutMs: target.decision.timeoutMs };
  const chat = target.chat;
  return chat === null
    ? null
    : {
        temperature: chat.temperature,
        maxTokens: chat.maxTokens,
        timeoutMs: chat.timeoutMs,
        maxRepairRetries: chat.maxRepairRetries,
        reasoningEffort: chat.reasoningEffort ?? null,
      };
}
export function targetConditionChanges(
  left: CellFacts,
  right: CellFacts,
  baseline: RunPlan,
  current: RunPlan,
): readonly string[] {
  const a = baseline.targets.find(
      (target) => target.targetId === left.targetId,
    ),
    b = current.targets.find((target) => target.targetId === right.targetId);
  if (a === undefined || b === undefined) return [];
  const changes: string[] = [];
  if (
    canonicalJson(route(a, left.protocol)) !==
    canonicalJson(route(b, right.protocol))
  )
    changes.push('execution-route');
  if (
    canonicalJson(settings(a, left.protocol)) !==
    canonicalJson(settings(b, right.protocol))
  )
    changes.push('model-settings');
  if (
    left.protocol === 'decision' &&
    a.decision !== null &&
    b.decision !== null &&
    a.decision.costTier !== b.decision.costTier
  )
    changes.push('cost-tier-configuration');
  if (
    left.protocol === 'chat' &&
    a.chat !== null &&
    b.chat !== null &&
    a.chat.maxRepairRetries !== b.chat.maxRepairRetries
  )
    changes.push('repair-configuration');
  return changes;
}
