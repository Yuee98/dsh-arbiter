/** Live workflow knowledge has an owner, finite bounds, and no silent eviction.
 * Weak owner/domain indexes don't keep a finished plugin or SQLite connection alive.
 */
import { CredentialRedactor } from './credential-redactor.js';

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
export function credentialRegistry(
  owner: object,
  domain?: string | null,
): CredentialRegistry {
  const previous = OWNERS.get(owner);
  if (previous !== undefined) {
    if (domain != null) {
      if (!DOMAINS.has(domain) && DOMAINS.size >= MAX_SCOPES * 8)
        throw new Error('credential registry owner limit exceeded');
      DOMAINS.set(domain, new WeakRef(previous));
    }
    return previous;
  }
  let registry = domain == null ? undefined : DOMAINS.get(domain)?.deref();
  if (registry === undefined) {
    registry = new CredentialRegistry();
    if (domain != null) {
      // Reclaim dead index entries only; never evict a live workflow's vocabulary.
      for (const [key, reference] of DOMAINS)
        if (reference.deref() === undefined) DOMAINS.delete(key);
      if (DOMAINS.size >= MAX_SCOPES * 8)
        throw new Error('credential registry owner limit exceeded');
      DOMAINS.set(domain, new WeakRef(registry));
    }
  }
  OWNERS.set(owner, registry);
  return registry;
}
