import type {
  CredentialStatusView,
  ModelCatalogFailureView,
  ModelCatalogView,
  ModelGroupView,
  ModelOptionView,
  ReviewerProbeAttemptView,
  ReviewerProbeView,
} from '../view-types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  number,
  object,
  optional,
  text,
  unknownValue,
} from './values.js';

function modelOption(value: unknown): ModelOptionView {
  const source = object(value);
  const description = field(source, 'description', optional(text));
  return {
    id: field(source, 'id', text),
    name: field(source, 'name', text),
    ...(description === undefined ? {} : { description }),
  };
}

function modelGroup(value: unknown): ModelGroupView {
  const source = object(value);
  return {
    id: field(source, 'id', text),
    name: field(source, 'name', text),
    models: field(source, 'models', array(modelOption)),
  };
}

function catalogFailure(value: unknown): ModelCatalogFailureView {
  const source = object(value);
  return {
    id: field(source, 'id', text),
    name: field(source, 'name', text),
    code: field(source, 'code', text),
  };
}

/**
 * Read the model directory.
 *
 * A failure carries only a stable code, so any extra provider text is dropped
 * instead of being rendered back to the page.
 */
export function modelCatalogResponse(value: unknown): ModelCatalogView {
  const source = object(value);
  // `ok` distinguishes a whole-directory failure from a successful empty
  // directory; treating them alike would report "no models" for a real fault.
  return {
    loaded: field(source, 'ok', boolean),
    supported: field(source, 'supported', boolean),
    groups: field(source, 'groups', array(modelGroup)),
    failures: field(source, 'failures', array(catalogFailure)),
  };
}

/**
 * Read the credential status.
 *
 * `state` is required so the page can never mistake "could not be determined"
 * for "not set"; `configured` and `source` stay for the text that renders them.
 */
export function credentialResponse(value: unknown): CredentialStatusView {
  const source = object(value);
  return {
    state: field(
      source,
      'state',
      choice('configured', 'unconfigured', 'unsupported', 'unavailable'),
    ),
    configured: field(source, 'configured', boolean),
    source: field(source, 'source', nullable(text)),
  };
}

function probeAttempt(value: unknown): ReviewerProbeAttemptView {
  const source = object(value);
  return {
    attempt: field(source, 'attempt', number),
    backend: field(source, 'backend', text),
    protocol: field(source, 'protocol', text),
    durationMs: field(source, 'durationMs', number),
    request: field(source, 'request', unknownValue),
    responseText: field(source, 'responseText', nullable(text)),
    // Model output and parser results stay raw data; only the surrounding
    // labels are localized.
    parsed: field(source, 'parsed', unknownValue),
    error: field(source, 'error', nullable(text)),
  };
}

function probeModel(value: Record<string, unknown>): {
  readonly provider: string;
  readonly model: string;
} {
  const model = field(value, 'model', object);
  return {
    provider: field(model, 'provider', text),
    model: field(model, 'model', text),
  };
}

/**
 * Read one connection test.
 *
 * A failed probe is still a successful read: the status and the stable failure
 * code are the answer. Unknown fields are dropped rather than trusted.
 */
export function probeResponse(value: unknown): ReviewerProbeView {
  const source = object(value);
  if (!field(source, 'ok', boolean)) {
    throw new TypeError('probe response is not ok');
  }
  const raw = field(source, 'probe', object);
  const status = field(raw, 'status', choice('passed', 'failed', 'cancelled'));
  const { provider, model } = probeModel(raw);
  const base = {
    backend: field(raw, 'backend', text),
    provider,
    model,
    protocol: field(raw, 'protocol', text),
    durationMs: field(raw, 'durationMs', number),
    attempts: field(raw, 'attempts', array(probeAttempt)),
  };
  if (status === 'passed') {
    return {
      status,
      ...base,
      repairs: field(raw, 'repairs', number),
    };
  }
  return {
    status,
    ...base,
    failure: field(
      raw,
      'failure',
      choice(
        'model-required',
        'credential-missing',
        'unauthorized',
        'rate-limited',
        'unavailable',
        'network',
        'timed-out',
        'invalid-output',
        'cancelled',
        'unknown',
      ),
    ),
  };
}
