import type {
  ArbiterConfig,
  ChatReviewerConfig,
  DecisionReviewerConfig,
  ConfigError,
  CostTier,
} from '../types.js';
import { asObject, asString, asNumber, asInteger, asEnum } from './values.js';

function parseChat(
  chatValue: Record<string, unknown>,
  errors: ConfigError[],
): ChatReviewerConfig {
  const chat: ChatReviewerConfig = {
    provider: asString(
      chatValue['provider'],
      'session',
      'reviewer.chat.provider',
      errors,
    ),
    model: asString(chatValue['model'], '', 'reviewer.chat.model', errors),
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
      10_000,
      16,
      // Reasoning tokens and the answer draw on one budget, so the ceiling has
      // to leave room for a long thinking pass before the JSON starts.
      32_000,
      'reviewer.chat.maxTokens',
      errors,
    ),
    timeoutMs: asInteger(
      chatValue['timeoutMs'],
      20_000,
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
    url: asString(decisionValue['url'], '', 'reviewer.decision.url', errors),
    model: asString(
      decisionValue['model'],
      'clef-flash',
      'reviewer.decision.model',
      errors,
    ),
    apiKeyRef: asString(
      decisionValue['apiKeyRef'],
      'CLOUDFLARE_API_TOKEN',
      'reviewer.decision.apiKeyRef',
      errors,
    ),
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
  const reviewerValue = asObject(raw['reviewer'], 'reviewer', errors);
  const chatValue = asObject(reviewerValue['chat'], 'reviewer.chat', errors);
  const decisionValue = asObject(
    reviewerValue['decision'],
    'reviewer.decision',
    errors,
  );
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
        code: 'reviewer.url-required',
      });
    } else if (!/^https?:\/\//u.test(decision.url)) {
      errors.push({
        path: 'reviewer.decision.url',
        message: 'must be an http(s) URL',
        code: 'reviewer.url-scheme',
      });
    }
    if (decision.apiKeyRef.length === 0) {
      errors.push({
        path: 'reviewer.decision.apiKeyRef',
        message: 'a decision backend requires a credential reference',
        code: 'reviewer.credential-required',
      });
    }
  }

  return { type: reviewerType, chat, decision };
}
