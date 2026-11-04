import type { ModelIdentity } from './types.js';

/** Model versions, parameters and protocols do not create independent voters. */
export function knownModelIdentity(model: ModelIdentity): string | null {
  const provider = model.provider.trim(),
    id = model.id.trim();
  if (
    provider === '' ||
    id === '' ||
    provider.toLowerCase() === 'unknown' ||
    id.toLowerCase() === 'unknown'
  )
    return null;
  return JSON.stringify([provider, id]);
}
