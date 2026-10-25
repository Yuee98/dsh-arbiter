import type {
  ArbiterConfig,
  CommandRule,
  ContextConfig,
  PolicyThresholds,
  ReviewerConfig,
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
export const ruleNode = choice(
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
);

export function commandRule(value: unknown): CommandRule {
  const source = object(value);
  const match = field(source, 'match', object);
  const comment = field(source, 'comment', optional(text));
  const enabled = field(source, 'enabled', optional(boolean));
  const hint = field(source, 'hint', optional(text));
  const tool = field(match, 'tool', optional(text));
  const selector = field(match, 'selector', optional(text));
  const agents = field(match, 'agents', optional(strings));
  return {
    id: field(source, 'id', text),
    verdict: field(source, 'verdict', ruleVerdict),
    ...(comment === undefined ? {} : { comment }),
    ...(enabled === undefined ? {} : { enabled }),
    ...(hint === undefined ? {} : { hint }),
    match: {
      node: field(match, 'node', ruleNode),
      kind: field(match, 'kind', choice('exact', 'regex', 'glob')),
      pattern: field(match, 'pattern', text),
      ...(tool === undefined ? {} : { tool }),
      ...(selector === undefined ? {} : { selector }),
      ...(agents === undefined ? {} : { agents }),
    },
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
