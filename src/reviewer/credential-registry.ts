/** Live workflow knowledge has an owner, finite bounds, and no silent eviction.
 * Weak owner/domain indexes don't keep a finished plugin or SQLite connection alive.
 */
import { realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { CredentialRedactor } from './credential-redactor.js';

/** SQLite reports physical filenames, while host domains can contain aliases. */
function credentialDomain(domain: string): string {
  if (!isAbsolute(domain)) return domain;
  try {
    return realpathSync(domain);
  } catch (error) {
    if (
      !(error instanceof Error) ||
      !('code' in error) ||
      error.code !== 'ENOENT'
    )
      throw error;
    return join(realpathSync(dirname(domain)), basename(domain));
  }
}

const OWNERS = new WeakMap<object, CredentialRegistry>();
const DOMAINS = new Map<string, WeakRef<CredentialRegistry>>();
const MAX_SCOPES = 4096;
export class CredentialRegistry {
  readonly #contexts = new Map<string, CredentialRedactor>();
  readonly #aliases = new Map<string, string>();
  #vocabularyBytes = 0;
  #exhausted = false;
  context(sessionId: string, parentId?: string | null): CredentialRedactor {
    if (this.#exhausted)
      throw new Error('credential workflow vocabulary limit exceeded');
    const root =
      this.#aliases.get(sessionId) ??
      (parentId == null
        ? sessionId
        : (this.#aliases.get(parentId) ?? parentId));
    let context = this.#contexts.get(root);
    if (context === undefined) {
      if (this.#contexts.size >= MAX_SCOPES)
        throw new Error('credential workflow context limit exceeded');
      context = new CredentialRedactor(root, [], undefined, (bytes) => {
        if (this.#vocabularyBytes + bytes > 32 * 1024 * 1024) {
          this.#exhausted = true;
          throw new Error('credential workflow vocabulary limit exceeded');
        }
        this.#vocabularyBytes += bytes;
      });
      this.#contexts.set(root, context);
    }
    if (!this.#aliases.has(sessionId) && this.#aliases.size >= MAX_SCOPES * 8)
      throw new Error('credential workflow identity limit exceeded');
    this.#aliases.set(sessionId, root);
    return context;
  }
  register(ids: readonly string[]): CredentialRedactor {
    const last = ids.at(-1) ?? 'unknown';
    const root = this.#aliases.get(last) ?? last;
    for (const id of ids) {
      const previous = this.#aliases.get(id);
      if (previous !== undefined && previous !== root)
        throw new Error(
          'credential workflow identity conflicts with established ancestry',
        );
    }
    if (this.#aliases.size + ids.length > MAX_SCOPES * 8)
      throw new Error('credential workflow identity limit exceeded');
    for (const id of ids) this.#aliases.set(id, root);
    return this.context(root);
  }
}
/** Preserve a live domain's knowledge rather than replacing it with an owner. */
function bindDomain(key: string, registry: CredentialRegistry): void {
  const established = DOMAINS.get(key)?.deref();
  if (established !== undefined && established !== registry)
    throw new Error(
      'credential registry conflicts with established file domain',
    );
  if (!DOMAINS.has(key) && DOMAINS.size >= MAX_SCOPES * 8)
    throw new Error('credential registry owner limit exceeded');
  DOMAINS.set(key, new WeakRef(registry));
}
export function credentialRegistry(
  owner: object,
  domain?: string | null,
): CredentialRegistry {
  const key = domain == null ? domain : credentialDomain(domain);
  const previous = OWNERS.get(owner);
  if (previous !== undefined) {
    if (key != null) bindDomain(key, previous);
    return previous;
  }
  let registry = key == null ? undefined : DOMAINS.get(key)?.deref();
  if (registry === undefined) {
    registry = new CredentialRegistry();
    if (key != null) {
      // Reclaim dead index entries only; never evict a live workflow's vocabulary.
      for (const [key, reference] of DOMAINS)
        if (reference.deref() === undefined) DOMAINS.delete(key);
      if (DOMAINS.size >= MAX_SCOPES * 8)
        throw new Error('credential registry owner limit exceeded');
      DOMAINS.set(key, new WeakRef(registry));
    }
  }
  OWNERS.set(owner, registry);
  return registry;
}
