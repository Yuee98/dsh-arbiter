/** Session ancestry links are identity metadata, never authorization content. */
import { parentChain } from '../host/admission.js';
import {
  credentialRegistry,
  type CredentialRegistry,
} from '../reviewer/credential-registry.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import type { SessionLike, SessionsLike } from './types.js';

export function workflowRedactor(
  session: SessionLike,
  sessions?: SessionsLike,
  registry?: CredentialRegistry,
): CredentialRedactor {
  const id = session.id ?? 'unknown';
  const chain = parentChain(
    id,
    (current) =>
      (current === id ? session : sessions?.get?.(current))?.header
        ?.parentSession,
  );
  if (chain.cycle || chain.unresolved !== null)
    throw new Error('credential workflow ancestry could not be resolved');
  const root = sessions?.get?.(chain.ids.at(-1) ?? id) ?? session;
  return (registry ?? credentialRegistry(root)).register(chain.ids);
}
