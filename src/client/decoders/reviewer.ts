import type {
  CredentialStatusView,
  ModelCatalogFailureView,
  ModelCatalogView,
  ModelGroupView,
  ModelOptionView,
} from '../view-types.js';
import {
  array,
  boolean,
  choice,
  field,
  nullable,
  object,
  optional,
  text,
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
