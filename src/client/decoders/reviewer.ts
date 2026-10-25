import { boolean, field, nullable, object, optional, text } from './values.js';

export function credentialResponse(value: unknown) {
  const source = object(value);
  const message = field(source, 'message', optional(text));
  return {
    configured: field(source, 'configured', boolean),
    source: field(source, 'source', nullable(text)),
    supported: field(source, 'supported', boolean),
    ...(message === undefined ? {} : { message }),
  };
}
