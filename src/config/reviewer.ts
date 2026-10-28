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

/** Whether the string parses as an absolute URL at all. */
function parseableUrl(url: string): boolean {
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
}

/**
 * The model name a Cloudflare model-specific endpoint serves, when the path has
 * that shape.
 *
 * Only `…/ai/run/@cf/cloudflare/{model}` is recognised. A looser
 * `…/ai/run/<vendor>/<model>` rule would be wrong twice over: it misses the real
 * path, whose vendor part is a scoped name containing its own slash, and it
 * would impose an equality requirement on a custom endpoint that happens to
 * share the prefix — endpoints this plugin has never seen keep working with
 * whatever model their operator configured.
 */
function pathModel(url: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(url).pathname;
  } catch {
    return null;
  }
  const match = /\/ai\/run\/@cf\/cloudflare\/([A-Za-z0-9._-]+)$/u.exec(
    pathname,
  );
  return match?.[1] ?? null;
}

/** Whether a recognisable path names a different model than the configured one. */
function modelMismatch(url: string, model: string): boolean {
  const served = pathModel(url);
  return served !== null && served !== model;
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
    } else if (
      !/^https?:\/\//u.test(decision.url) ||
      !parseableUrl(decision.url)
    ) {
      // A scheme prefix alone is not a URL: `https://` passes the pattern above
      // and then throws when the adapter needs its pathname, which would surface
      // as a runtime fault rather than a configuration error.
      errors.push({
        path: 'reviewer.decision.url',
        message: 'must be an http(s) URL',
        code: 'reviewer.url-scheme',
      });
    }
    if (decision.model.length === 0) {
      // `asString` accepts an explicit empty string, so the model's presence is
      // this check's job. An empty model reaches the provider as a request for
      // nothing and comes back as an opaque refusal.
      errors.push({
        path: 'reviewer.decision.model',
        message: 'a decision backend requires a model',
        code: 'reviewer.model-required',
      });
    } else if (modelMismatch(decision.url, decision.model)) {
      errors.push({
        path: 'reviewer.decision.model',
        message: `the endpoint serves "${pathModel(decision.url) ?? ''}", not "${decision.model}"`,
        code: 'reviewer.model-mismatch',
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
