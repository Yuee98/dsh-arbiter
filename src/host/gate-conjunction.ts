/**
 * The conjunction witness a rule-stage record must carry.
 *
 * Written only when the deciding rule actually used `all`: an `any` rule's reason
 * is one condition, so attaching a witness list would suggest a joint basis it
 * never had. Kept out of the gate because it is a projection of the evaluation,
 * not part of deciding the call.
 */

import type {
  RuleConjunctionEvidence,
  RuleEvaluation,
  RulePath,
} from '../types.js';

export function ruleConjunctionStage(
  evaluation: RuleEvaluation,
  path: RulePath,
): { readonly conjunction?: RuleConjunctionEvidence } {
  if (path.kind !== 'rule') return {};
  const result = evaluation.rules.find((entry) => entry.id === path.ruleId);
  if (result === undefined) return {};
  if (result.combine !== 'all') return {};
  return { conjunction: { combine: 'all', groups: result.groups ?? [] } };
}
