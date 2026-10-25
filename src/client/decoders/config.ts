import type {
  ArbiterConfig,
  CommandRule,
  ContextConfig,
  PolicyThresholds,
  ReviewerConfig,
  RuleCondition,
  RuleScope,
} from '../../types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  optional,
  strings,
  text,
} from './values.js';

export const ruleVerdict = choice('allow', 'deny', 'force-ask', 'force-review');
export const ruleTarget = choice(
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
  'argument',
);
export const ruleKind = choice('exact', 'regex', 'glob');
export const ruleMulti = choice('any', 'all');

/** A pattern keeps the JSON type it was written with. */
function rulePattern(value: unknown): string | number | boolean | null {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  throw new TypeError('expected a string, number, boolean or null');
}

function ruleCondition(value: unknown): RuleCondition {
  const source = object(value);
  const path = field(source, 'path', optional(text));
  const caseSensitive = field(source, 'caseSensitive', optional(boolean));
  const multi = field(source, 'multi', optional(ruleMulti));
  return {
    target: field(source, 'target', ruleTarget),
    kind: field(source, 'kind', ruleKind),
    pattern: field(source, 'pattern', rulePattern),
    ...(path === undefined ? {} : { path }),
    ...(caseSensitive === undefined ? {} : { caseSensitive }),
    ...(multi === undefined ? {} : { multi }),
  };
}

function ruleScope(value: unknown): RuleScope {
  const source = object(value);
  const tools = field(source, 'tools', optional(strings));
  const agents = field(source, 'agents', optional(strings));
  return {
    ...(tools === undefined ? {} : { tools }),
    ...(agents === undefined ? {} : { agents }),
  };
}

export function commandRule(value: unknown): CommandRule {
  const source = object(value);
  const name = field(source, 'name', optional(text));
  const comment = field(source, 'comment', optional(text));
  const enabled = field(source, 'enabled', optional(boolean));
  const hint = field(source, 'hint', optional(text));
  const scope = field(source, 'scope', optional(ruleScope));
  return {
    id: field(source, 'id', text),
    verdict: field(source, 'verdict', ruleVerdict),
    conditions: field(source, 'conditions', array(ruleCondition)),
    ...(name === undefined ? {} : { name }),
    ...(comment === undefined ? {} : { comment }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(hint === undefined ? {} : { hint }),
    ...(scope === undefined ? {} : { scope }),
  };
}

function thresholds(value: unknown): PolicyThresholds {
  const source = object(value);
  return {
    tauAuth: field(source, 'tauAuth', number),
    tauRisk: field(source, 'tauRisk', number),
    tauCritical: field(source, 'tauCritical', number),
    tauLow: field(source, 'tauLow', number),
    chatLowRiskMax: field(source, 'chatLowRiskMax', number),
    chatMediumRiskMax: field(source, 'chatMediumRiskMax', number),
    mediumRiskCeiling: field(source, 'mediumRiskCeiling', number),
    explicitFromRisk: field(source, 'explicitFromRisk', number),
    allowBulkEgress: field(source, 'allowBulkEgress', boolean),
  };
}

function reviewer(value: unknown): ReviewerConfig {
  const source = object(value);
  const chat = field(source, 'chat', object);
  const decision = field(source, 'decision', object);
  return {
    type: field(source, 'type', choice('chat', 'decision')),
    chat: {
      provider: field(chat, 'provider', text),
      model: field(chat, 'model', text),
      temperature: field(chat, 'temperature', number),
      maxTokens: field(chat, 'maxTokens', number),
      timeoutMs: field(chat, 'timeoutMs', number),
      maxRepairRetries: field(chat, 'maxRepairRetries', number),
    },
    decision: {
      url: field(decision, 'url', text),
      model: field(decision, 'model', text),
      apiKeyRef: field(decision, 'apiKeyRef', text),
      timeoutMs: field(decision, 'timeoutMs', number),
      costTier: field(decision, 'costTier', choice('free', 'paid')),
    },
  };
}

function context(value: unknown): ContextConfig {
  const source = object(value);
  const projectRules = field(source, 'projectRules', object);
  return {
    maxInputTokens: field(source, 'maxInputTokens', number),
    evidenceMaxItems: field(source, 'evidenceMaxItems', number),
    parentHumanItems: field(source, 'parentHumanItems', number),
    parentEvidenceFloor: field(source, 'parentEvidenceFloor', number),
    historyMaxItems: field(source, 'historyMaxItems', number),
    checkpointMaxItems: field(source, 'checkpointMaxItems', number),
    toolCallArgumentMaxChars: field(source, 'toolCallArgumentMaxChars', number),
    customRules: field(source, 'customRules', text),
    projectRules: {
      enabled: field(projectRules, 'enabled', boolean),
      files: field(projectRules, 'files', strings),
    },
  };
}

export function configuration(value: unknown): ArbiterConfig {
  const source = object(value);
  // A declared format is optional; dropping it here would erase the declaration
  // when the browser saves its draft back through the host.
  const format = field(source, 'format', optional(text));
  const modes = field(source, 'modes', object);
  const policy = field(source, 'policy', object);
  const audit = field(source, 'audit', object);
  const breaker = field(source, 'breaker', object);
  return {
    ...(format === undefined ? {} : { format }),
    enabled: field(source, 'enabled', boolean),
    // An older host answers without the field; absence keeps the confirmed
    // default instead of failing the whole page, while a supplied value must
    // still be one of the two boundaries.
    boundary:
      field(source, 'boundary', optional(choice('guarded', 'trusted'))) ??
      'guarded',
    modes: {
      main: field(modes, 'main', choice('normal', 'strict', 'progress')),
      subagent: field(modes, 'subagent', choice('strict', 'progress')),
    },
    rules: field(source, 'rules', array(commandRule)),
    reviewer: field(source, 'reviewer', reviewer),
    policy: {
      version: field(policy, 'version', text),
      normal: field(policy, 'normal', thresholds),
      progress: field(policy, 'progress', thresholds),
      probeMode: field(policy, 'probeMode', choice('assist', 'override')),
    },
    context: field(source, 'context', context),
    audit: {
      enabled: field(audit, 'enabled', boolean),
      retentionDays: field(audit, 'retentionDays', number),
      retentionBytes: field(audit, 'retentionBytes', number),
      maxQueue: field(audit, 'maxQueue', number),
    },
    breaker: {
      mode: field(breaker, 'mode', choice('off', 'preset', 'custom')),
      preset: field(breaker, 'preset', choice('strict', 'balanced', 'lenient')),
      consecutiveDenials: field(breaker, 'consecutiveDenials', number),
      windowDenials: field(breaker, 'windowDenials', number),
      windowSize: field(breaker, 'windowSize', number),
    },
    reviewBudget: field(source, 'reviewBudget', nullable(number)),
  };
}
