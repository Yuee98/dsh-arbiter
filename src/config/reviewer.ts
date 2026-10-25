import type {
  ArbiterConfig,
  ChatReviewerConfig,
  DecisionReviewerConfig,
  ConfigError,
  CostTier,
} from '../types.js';
import { isRecord, asString, asNumber, asInteger, asEnum } from './values.js';

function parseChat(
  chatValue: Record<string, unknown>,
  errors: ConfigError[],
): ChatReviewerConfig {
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
  return chat;
}

function parseDecision(
  decisionValue: Record<string, unknown>,
  errors: ConfigError[],
): DecisionReviewerConfig {
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
  return decision;
}

export function parseReviewer(
  raw: Record<string, unknown>,
  errors: ConfigError[],
): ArbiterConfig['reviewer'] {
  const reviewerValue = isRecord(raw['reviewer']) ? raw['reviewer'] : {};
  const chatValue = isRecord(reviewerValue['chat'])
    ? reviewerValue['chat']
    : {};
  const decisionValue = isRecord(reviewerValue['decision'])
    ? reviewerValue['decision']
    : {};
  const chat = parseChat(chatValue, errors);
  const decision = parseDecision(decisionValue, errors);
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

  return { type: reviewerType, chat, decision };
}
