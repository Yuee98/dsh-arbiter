/**
 * Configuration shape, defaults, validation and normalization.
 *
 * The profile patch is the single editable source of truth. This module only
 * projects it into a complete effective configuration and reports errors; the
 * host keeps the last effective configuration when a candidate is invalid.
 */

import { validateRules } from './rules/match.js';
import type {
  ArbiterConfig,
  AuditConfig,
  BreakerConfig,
  BreakerPreset,
  ChatReviewerConfig,
  CommandRule,
  ConfigError,
  ConfigParseResult,
  ConfigWarning,
  ContextConfig,
  CostTier,
  DecisionReviewerConfig,
  PolicyConfig,
  PolicyThresholds,
  ProbeMode,
  RuleKind,
  RuleMatchSpec,
  RuleNode,
  RuleVerdict,
  SubagentMode,
  ApprovalMode,
} from './types.js';

export const POLICY_VERSION = 'arbiter-policy-v1';

const DEFAULT_NORMAL: PolicyThresholds = {
  tauAuth: 0.8,
  tauRisk: 0.75,
  tauCritical: 0.25,
  tauLow: 0.7,
  chatLowRiskMax: 3,
  chatMediumRiskMax: 6,
  mediumRiskCeiling: 6,
  explicitFromRisk: 4,
  allowBulkEgress: false,
};

const DEFAULT_PROGRESS: PolicyThresholds = {
  ...DEFAULT_NORMAL,
  chatMediumRiskMax: 8,
  mediumRiskCeiling: 8,
  allowBulkEgress: true,
};

export const DEFAULT_CONFIG: ArbiterConfig = {
  enabled: true,
  modes: { main: 'normal', subagent: 'strict' },
  rules: [],
  reviewer: {
    type: 'chat',
    chat: {
      provider: 'session',
      model: '',
      temperature: 0,
      maxTokens: 400,
      timeoutMs: 8_000,
      maxRepairRetries: 1,
    },
    decision: {
      url: '',
      model: 'clef-flash',
      apiKeyRef: 'CLOUDFLARE_API_TOKEN',
      timeoutMs: 8_000,
      costTier: 'paid',
    },
  },
  policy: {
    version: POLICY_VERSION,
    normal: DEFAULT_NORMAL,
    progress: DEFAULT_PROGRESS,
    probeMode: 'assist',
  },
  context: {
    maxInputTokens: 10_000,
    evidenceMaxItems: 20,
    parentHumanItems: 5,
    parentEvidenceFloor: 1,
    historyMaxItems: 40,
    checkpointMaxItems: 3,
    toolCallArgumentMaxChars: 200,
    customRules: '',
    projectRules: { enabled: true, files: ['.dsh/arbiter.md', '.arbiter.md'] },
  },
  audit: {
    enabled: true,
    retentionDays: 30,
    retentionBytes: 1024 * 1024 * 1024,
    maxQueue: 500,
  },
  breaker: {
    mode: 'preset',
    preset: 'balanced',
    consecutiveDenials: 3,
    windowDenials: 6,
    windowSize: 10,
  },
  reviewBudget: null,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function asNumber(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
  errors: ConfigError[],
): number {
  if (value === undefined) return fallback;
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    errors.push({ path, message: 'must be a finite number' });
    return fallback;
  }
  if (value < min || value > max) {
    errors.push({
      path,
      message: `must be between ${String(min)} and ${String(max)}`,
    });
    return fallback;
  }
  return value;
}

function asInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  path: string,
  errors: ConfigError[],
): number {
  const number = asNumber(value, fallback, min, max, path, errors);
  if (!Number.isInteger(number)) {
    errors.push({ path, message: 'must be an integer' });
    return fallback;
  }
  return number;
}

function asEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
  path: string,
  errors: ConfigError[],
): T {
  if (value === undefined) return fallback;
  if (typeof value === 'string') {
    const match = allowed.find((entry) => entry === value);
    if (match !== undefined) return match;
  }
  errors.push({ path, message: `must be one of ${allowed.join(', ')}` });
  return fallback;
}

function parseThresholds(
  value: unknown,
  fallback: PolicyThresholds,
  path: string,
  errors: ConfigError[],
): PolicyThresholds {
  if (!isRecord(value)) {
    if (value !== undefined)
      errors.push({ path, message: 'must be an object' });
    return fallback;
  }
  const probability = (
    key: 'tauAuth' | 'tauRisk' | 'tauCritical' | 'tauLow',
  ): number =>
    asNumber(value[key], fallback[key], 0, 1, `${path}.${key}`, errors);
  return {
    tauAuth: probability('tauAuth'),
    tauRisk: probability('tauRisk'),
    tauCritical: probability('tauCritical'),
    tauLow: probability('tauLow'),
    chatLowRiskMax: asInteger(
      value['chatLowRiskMax'],
      fallback.chatLowRiskMax,
      0,
      10,
      `${path}.chatLowRiskMax`,
      errors,
    ),
    chatMediumRiskMax: asInteger(
      value['chatMediumRiskMax'],
      fallback.chatMediumRiskMax,
      0,
      10,
      `${path}.chatMediumRiskMax`,
      errors,
    ),
    mediumRiskCeiling: asInteger(
      value['mediumRiskCeiling'],
      fallback.mediumRiskCeiling,
      0,
      10,
      `${path}.mediumRiskCeiling`,
      errors,
    ),
    explicitFromRisk: asInteger(
      value['explicitFromRisk'],
      fallback.explicitFromRisk,
      0,
      10,
      `${path}.explicitFromRisk`,
      errors,
    ),
    allowBulkEgress: asBoolean(
      value['allowBulkEgress'],
      fallback.allowBulkEgress,
    ),
  };
}

const RULE_NODES: readonly RuleNode[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
];
const RULE_KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];
const RULE_VERDICTS: readonly RuleVerdict[] = [
  'allow',
  'deny',
  'force-ask',
  'force-review',
];

function parseRule(
  value: unknown,
  index: number,
  errors: ConfigError[],
): CommandRule | null {
  const path = `rules[${String(index)}]`;
  if (!isRecord(value)) {
    errors.push({ path, message: 'must be an object' });
    return null;
  }
  const id = typeof value['id'] === 'string' ? value['id'].trim() : '';
  if (id.length === 0)
    errors.push({ path: `${path}.id`, message: 'must be a non-empty string' });
  const matchValue = value['match'];
  if (!isRecord(matchValue)) {
    errors.push({ path: `${path}.match`, message: 'must be an object' });
    return null;
  }
  const node = asEnum(
    matchValue['node'],
    RULE_NODES,
    'command',
    `${path}.match.node`,
    errors,
  );
  const kind = asEnum(
    matchValue['kind'],
    RULE_KINDS,
    'exact',
    `${path}.match.kind`,
    errors,
  );
  const pattern =
    typeof matchValue['pattern'] === 'string' ? matchValue['pattern'] : '';
  if (pattern.length === 0) {
    errors.push({
      path: `${path}.match.pattern`,
      message: 'must be a non-empty string',
    });
  }
  const match: RuleMatchSpec = {
    node,
    kind,
    pattern,
    ...(typeof matchValue['tool'] === 'string'
      ? { tool: matchValue['tool'] }
      : {}),
    ...(typeof matchValue['selector'] === 'string'
      ? { selector: matchValue['selector'] }
      : {}),
    ...(Array.isArray(matchValue['agents'])
      ? {
          agents: matchValue['agents'].filter(
            (agent): agent is string => typeof agent === 'string',
          ),
        }
      : {}),
  };
  const verdict = asEnum(
    value['verdict'],
    RULE_VERDICTS,
    'allow',
    `${path}.verdict`,
    errors,
  );
  const rule: CommandRule = {
    id,
    match,
    verdict,
    ...(typeof value['comment'] === 'string'
      ? { comment: value['comment'] }
      : {}),
    ...(typeof value['hint'] === 'string' ? { hint: value['hint'] } : {}),
    ...(typeof value['enabled'] === 'boolean'
      ? { enabled: value['enabled'] }
      : {}),
  };
  return rule;
}

function literalPrefix(pattern: string): string {
  let source = pattern;
  if (source.startsWith('^')) source = source.slice(1);
  else if (source.startsWith('(?:^')) source = source.slice(4);
  let out = '';
  let escaped = false;
  for (const char of source) {
    if (escaped) {
      out += char;
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if ('.*+?()[]{}|^$'.includes(char)) break;
    out += char;
  }
  return out;
}

function ruleWarnings(rules: readonly CommandRule[]): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];
  const allowRules = rules.filter(
    (rule) => rule.verdict === 'allow' && rule.enabled !== false,
  );
  const forceReviewRules = rules.filter(
    (rule) => rule.verdict === 'force-review' && rule.enabled !== false,
  );
  for (const allow of allowRules) {
    for (const review of forceReviewRules) {
      if (allow.match.node !== review.match.node) continue;
      if (allow.match.tool !== review.match.tool) continue;
      if (allow.match.selector !== review.match.selector) continue;
      if (allow.match.agents !== undefined || review.match.agents !== undefined)
        continue;
      const reviewPrefix = literalPrefix(review.match.pattern);
      const allowPrefix = literalPrefix(allow.match.pattern);
      if (
        review.match.pattern === allow.match.pattern ||
        (reviewPrefix.length > 0 &&
          (allowPrefix.startsWith(reviewPrefix) ||
            reviewPrefix.startsWith(allowPrefix)))
      ) {
        warnings.push({
          path: `rules.${allow.id}`,
          message: `allow rule "${allow.id}" may be shadowed by force-review rule "${review.id}"`,
        });
      }
    }
  }
  return warnings;
}

/**
 * Validate and normalize an arbitrary configuration value.
 *
 * Invalid fields keep their default value and are reported; the caller decides
 * whether to apply the candidate. Invalid individual rules are dropped only
 * after being reported, so a typo never silently becomes an allow.
 */
export function parseConfig(raw: unknown): ConfigParseResult {
  const errors: ConfigError[] = [];
  const warnings: ConfigWarning[] = [];
  if (!isRecord(raw)) {
    errors.push({ path: '', message: 'configuration must be an object' });
    return { config: DEFAULT_CONFIG, errors, warnings };
  }

  const modesValue = isRecord(raw['modes']) ? raw['modes'] : {};
  const modes = {
    main: asEnum<ApprovalMode>(
      modesValue['main'],
      ['normal', 'strict', 'progress'],
      'normal',
      'modes.main',
      errors,
    ),
    subagent: asEnum<SubagentMode>(
      modesValue['subagent'],
      ['strict', 'progress'],
      'strict',
      'modes.subagent',
      errors,
    ),
  };

  const rulesRaw = Array.isArray(raw['rules']) ? raw['rules'] : [];
  if (raw['rules'] !== undefined && !Array.isArray(raw['rules'])) {
    errors.push({ path: 'rules', message: 'must be an array' });
  }
  const rules: CommandRule[] = [];
  rulesRaw.forEach((value, index) => {
    const rule = parseRule(value, index, errors);
    if (rule !== null) rules.push(rule);
  });

  const reviewerValue = isRecord(raw['reviewer']) ? raw['reviewer'] : {};
  const chatValue = isRecord(reviewerValue['chat'])
    ? reviewerValue['chat']
    : {};
  const decisionValue = isRecord(reviewerValue['decision'])
    ? reviewerValue['decision']
    : {};
  const chat: ChatReviewerConfig = {
    provider: asString(chatValue['provider'], 'session'),
    model: asString(chatValue['model'], ''),
    temperature: asNumber(
      chatValue['temperature'],
      0,
      0,
      2,
      'reviewer.chat.temperature',
      errors,
    ),
    maxTokens: asInteger(
      chatValue['maxTokens'],
      400,
      16,
      4_000,
      'reviewer.chat.maxTokens',
      errors,
    ),
    timeoutMs: asInteger(
      chatValue['timeoutMs'],
      8_000,
      500,
      120_000,
      'reviewer.chat.timeoutMs',
      errors,
    ),
    maxRepairRetries: asInteger(
      chatValue['maxRepairRetries'],
      1,
      0,
      3,
      'reviewer.chat.maxRepairRetries',
      errors,
    ),
  };
  const decision: DecisionReviewerConfig = {
    url: asString(decisionValue['url'], ''),
    model: asString(decisionValue['model'], 'clef-flash'),
    apiKeyRef: asString(decisionValue['apiKeyRef'], 'CLOUDFLARE_API_TOKEN'),
    timeoutMs: asInteger(
      decisionValue['timeoutMs'],
      8_000,
      500,
      120_000,
      'reviewer.decision.timeoutMs',
      errors,
    ),
    costTier: asEnum<CostTier>(
      decisionValue['costTier'],
      ['free', 'paid'],
      'paid',
      'reviewer.decision.costTier',
      errors,
    ),
  };
  const reviewerType = asEnum<'chat' | 'decision'>(
    reviewerValue['type'],
    ['chat', 'decision'],
    'chat',
    'reviewer.type',
    errors,
  );
  if (reviewerType === 'decision') {
    if (decision.url.length === 0) {
      errors.push({
        path: 'reviewer.decision.url',
        message: 'a decision backend requires a URL',
      });
    } else if (!/^https?:\/\//u.test(decision.url)) {
      errors.push({
        path: 'reviewer.decision.url',
        message: 'must be an http(s) URL',
      });
    }
    if (decision.apiKeyRef.length === 0) {
      errors.push({
        path: 'reviewer.decision.apiKeyRef',
        message: 'a decision backend requires a credential reference',
      });
    }
  }

  const policyValue = isRecord(raw['policy']) ? raw['policy'] : {};
  const policy: PolicyConfig = {
    version: POLICY_VERSION,
    normal: parseThresholds(
      policyValue['normal'],
      DEFAULT_NORMAL,
      'policy.normal',
      errors,
    ),
    progress: parseThresholds(
      policyValue['progress'],
      DEFAULT_PROGRESS,
      'policy.progress',
      errors,
    ),
    probeMode: asEnum<ProbeMode>(
      policyValue['probeMode'],
      ['assist', 'override'],
      'assist',
      'policy.probeMode',
      errors,
    ),
  };

  const contextValue = isRecord(raw['context']) ? raw['context'] : {};
  const projectValue = isRecord(contextValue['projectRules'])
    ? contextValue['projectRules']
    : {};
  const projectFiles = Array.isArray(projectValue['files'])
    ? projectValue['files'].filter(
        (file): file is string => typeof file === 'string',
      )
    : ['.dsh/arbiter.md', '.arbiter.md'];
  const customRules = asString(contextValue['customRules'], '');
  if (customRules.length > 2_000) {
    errors.push({
      path: 'context.customRules',
      message: 'must be at most 2000 characters',
    });
  }
  const parentHumanItems = asInteger(
    contextValue['parentHumanItems'],
    5,
    0,
    100,
    'context.parentHumanItems',
    errors,
  );
  const parentEvidenceFloor = asInteger(
    contextValue['parentEvidenceFloor'],
    1,
    0,
    100,
    'context.parentEvidenceFloor',
    errors,
  );
  if (parentEvidenceFloor > parentHumanItems) {
    errors.push({
      path: 'context.parentEvidenceFloor',
      message: 'must not exceed context.parentHumanItems',
    });
  }
  const context: ContextConfig = {
    maxInputTokens: asInteger(
      contextValue['maxInputTokens'],
      10_000,
      1_000,
      200_000,
      'context.maxInputTokens',
      errors,
    ),
    evidenceMaxItems: asInteger(
      contextValue['evidenceMaxItems'],
      20,
      1,
      200,
      'context.evidenceMaxItems',
      errors,
    ),
    parentHumanItems,
    parentEvidenceFloor,
    historyMaxItems: asInteger(
      contextValue['historyMaxItems'],
      40,
      1,
      400,
      'context.historyMaxItems',
      errors,
    ),
    checkpointMaxItems: asInteger(
      contextValue['checkpointMaxItems'],
      3,
      0,
      20,
      'context.checkpointMaxItems',
      errors,
    ),
    toolCallArgumentMaxChars: asInteger(
      contextValue['toolCallArgumentMaxChars'],
      200,
      20,
      10_000,
      'context.toolCallArgumentMaxChars',
      errors,
    ),
    customRules,
    projectRules: {
      enabled: asBoolean(projectValue['enabled'], true),
      files:
        projectFiles.length > 0
          ? projectFiles
          : ['.dsh/arbiter.md', '.arbiter.md'],
    },
  };

  const auditValue = isRecord(raw['audit']) ? raw['audit'] : {};
  const audit: AuditConfig = {
    enabled: asBoolean(auditValue['enabled'], true),
    retentionDays: asInteger(
      auditValue['retentionDays'],
      30,
      1,
      3_650,
      'audit.retentionDays',
      errors,
    ),
    retentionBytes: asInteger(
      auditValue['retentionBytes'],
      1024 * 1024 * 1024,
      1024 * 1024,
      1024 * 1024 * 1024 * 1024,
      'audit.retentionBytes',
      errors,
    ),
    maxQueue: asInteger(
      auditValue['maxQueue'],
      500,
      1,
      100_000,
      'audit.maxQueue',
      errors,
    ),
  };

  const breakerValue = isRecord(raw['breaker']) ? raw['breaker'] : {};
  const breaker: BreakerConfig = {
    mode: asEnum<'off' | 'preset' | 'custom'>(
      breakerValue['mode'],
      ['off', 'preset', 'custom'],
      'preset',
      'breaker.mode',
      errors,
    ),
    preset: asEnum<BreakerPreset>(
      breakerValue['preset'],
      ['strict', 'balanced', 'lenient'],
      'balanced',
      'breaker.preset',
      errors,
    ),
    consecutiveDenials: asInteger(
      breakerValue['consecutiveDenials'],
      3,
      0,
      100,
      'breaker.consecutiveDenials',
      errors,
    ),
    windowDenials: asInteger(
      breakerValue['windowDenials'],
      6,
      0,
      100,
      'breaker.windowDenials',
      errors,
    ),
    windowSize: asInteger(
      breakerValue['windowSize'],
      10,
      1,
      100,
      'breaker.windowSize',
      errors,
    ),
  };

  const reviewBudget =
    raw['reviewBudget'] === null || raw['reviewBudget'] === undefined
      ? null
      : asInteger(raw['reviewBudget'], 0, 1, 1_000_000, 'reviewBudget', errors);

  const config: ArbiterConfig = {
    enabled: asBoolean(raw['enabled'], true),
    modes,
    rules,
    reviewer: { type: reviewerType, chat, decision },
    policy,
    context,
    audit,
    breaker,
    reviewBudget,
  };

  for (const error of validateRules(rules)) {
    errors.push({
      path: error.path,
      message: `${error.message} (rule "${error.id}")`,
    });
  }
  if (config.breaker.windowDenials > config.breaker.windowSize) {
    errors.push({
      path: 'breaker.windowDenials',
      message: 'must not exceed breaker.windowSize',
    });
  }
  warnings.push(...ruleWarnings(rules));
  return { config, errors, warnings };
}

/** A stable content identity for the effective configuration. */
export function configHash(config: ArbiterConfig): string {
  return stableHash(JSON.stringify(config));
}

/** Small deterministic FNV-1a hash; enough for a revision label, not a security hash. */
export function stableHash(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function modeForSession(
  config: ArbiterConfig,
  sessionKind: 'main' | 'subagent',
): ApprovalMode {
  return sessionKind === 'main' ? config.modes.main : config.modes.subagent;
}
