import { jsonCopySpans } from './credential-json.js';
import { uniqueCredentialRecord } from './credential-record.js';
import {
  knownCredentialSpans,
  credentialLiteralContexts,
} from './credential-occurrences.js';
import {
  CredentialScoreContext,
  type CredentialScoreMode,
} from './credential-scores.js';
import { extractJsonObject } from './json.js';
import {
  quotedCredentialSpans,
  applyCredentialSpans,
  structuredJson,
} from './credential-literals.js';
/** Bounded, transient credential vocabulary. Never serialize a raw-value mapping.
 * IDs are scoped HMACs, stable within this process; restart continuity and arbitrary
 * unlabelled/unknown PII are deliberately outside automatic recognition.
 */
import {
  credentialIdentity,
  credentialMarker,
  verifiedCredentialMarker,
  CREDENTIAL_MARKER_SOURCE,
} from './credential-markers.js';
import { maskAuthentication } from './credential-auth.js';
import {
  credentialKind,
  maskExplicitFields,
  maskCredentialQueries,
  quotedValue,
  reQuote,
  type CredentialKind,
} from './credential-fields.js';
import {
  cookieFieldKind,
  cookieParts,
  type CookieFieldKind,
} from './credential-cookies.js';

const MAX_TEXT = 16 * 1024 * 1024;
const MAX_NODES = 100_000;
const MAX_VALUES = 1024;
const MAX_VOCABULARY = 256 * 1024;
const MARKER = new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu');
const AUTH_WORDS =
  /^(?:(?:approved|allowed|denied|granted|forbidden|permitted|delegated)(?:$|\s+(?:for|to|by|within|only|under)\b)|true$|false$|none$)/iu;
const MATERIAL_CONTEXT = new CredentialScoreContext(undefined, false);
const JSON_OPENERS = new Set<string | undefined>(['{', '[', '"']);
interface Secret {
  readonly value: string;
  readonly marker: string;
}
function unparsedAuthorization(
  kind: string,
  value: string,
  quote: string,
  decoded: boolean,
): boolean {
  return (
    !decoded &&
    kind === 'authorization' &&
    quote === '' &&
    ['{', '['].includes(value)
  );
}

export class CredentialRedactor {
  readonly #scope: string;
  readonly #secrets = new Map<string, Secret>();
  readonly #parent: CredentialRedactor | undefined;
  readonly #onLearn: ((bytes: number) => void) | undefined;
  #bytes = 0;
  #failed = false;
  #jsonDepth = 0;
  constructor(
    scope: string,
    known: readonly string[] = [],
    parent?: CredentialRedactor,
    onLearn?: (bytes: number) => void,
  ) {
    this.#scope = scope;
    this.#parent = parent;
    this.#onLearn = onLearn;
    if (parent !== undefined) {
      for (const value of parent.#secrets.values())
        this.#secrets.set(value.value, value);
      this.#bytes = parent.#bytes;
    }
    this.addKnown(known);
  }
  fork(): CredentialRedactor {
    this.check('');
    return new CredentialRedactor(this.#scope, [], this);
  }
  get revision(): number {
    return this.#secrets.size;
  }
  addKnown(values: readonly string[]): void {
    for (const value of values) this.learn(value, 'credential', true);
  }
  sensitiveValue(value: unknown, kind: CredentialKind): unknown {
    this.discover(value);
    const active = new WeakSet<object>();
    let nodes = 0;
    const copy = (item: unknown): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES) this.fail();
      if (typeof item === 'string' || typeof item === 'number')
        return this.learn(String(item), kind);
      if (item === null || typeof item !== 'object') return item;
      if (active.has(item)) return '[circular]';
      active.add(item);
      this.checkArrayLimit(item);
      const result = Array.isArray(item)
        ? item.map(copy)
        : uniqueCredentialRecord(
            Object.entries(item).map(([key, entry]) => [
              this.keyText(key),
              copy(entry),
            ]),
          );
      active.delete(item);
      return result;
    };
    return copy(value);
  }
  private fail(): never {
    this.#failed = true;
    throw new Error('credential redaction resource limit exceeded');
  }
  private check(text: string): void {
    this.#parent?.check('');
    if (this.#failed || text.length > MAX_TEXT) this.fail();
  }
  private learn(value: string, kind: CredentialKind, known = false): string {
    this.check(value);
    const old = this.#secrets.get(value);
    if (old !== undefined) return old.marker;
    if (value.length === 0 || (!known && this.isMarker(value))) return value;
    const bytes = Buffer.byteLength(value);
    if (
      this.#secrets.size >= MAX_VALUES ||
      this.#bytes + bytes > MAX_VOCABULARY
    )
      this.fail();
    if (this.#parent === undefined) {
      try {
        this.#onLearn?.(bytes);
      } catch {
        this.fail();
      }
    }
    const identity = credentialIdentity(this.#scope, value);
    const marker =
      this.#parent === undefined
        ? credentialMarker(kind, identity)
        : this.#parent.learn(value, kind, known);
    this.#secrets.set(value, { value, marker });
    this.#bytes += bytes;
    return marker;
  }
  private isMarker(value: string): boolean {
    return verifiedCredentialMarker(value);
  }
  private opaque(value: string): string {
    return credentialMarker(
      'credential',
      credentialIdentity(this.#scope, value, 'opaque'),
    );
  }
  private mask = (raw: string, kind: string, decoded = false): string => {
    const { value, quote } = decoded
      ? { value: raw, quote: '' }
      : quotedValue(raw);
    const known = this.#secrets.get(value);
    if (known !== undefined) return reQuote(known.marker, quote);
    if (kind === 'authorization' && AUTH_WORDS.test(value))
      return this.knownText(raw);
    // A malformed object's delimiter is not a credential vocabulary entry.
    if (unparsedAuthorization(kind, value, quote, decoded))
      return this.opaque(value);
    const cookie = cookieFieldKind(kind);
    if (cookie !== null) return reQuote(this.cookies(value, cookie), quote);
    const category: CredentialKind =
      kind === 'password' || kind === 'private-key' ? kind : 'token';
    const scheme =
      kind === 'authorization'
        ? /^(Bearer|Basic|Digest|Token)\s+(.+)$/isu.exec(value)
        : null;
    if (scheme !== null)
      return reQuote(
        `${scheme[1] ?? ''} ${this.learn(scheme[2] ?? '', 'token')}`,
        quote,
      );
    return reQuote(this.learn(value, category), quote);
  };
  private cookieValue(raw: string): string {
    const { value, quote } = raw.startsWith('"')
      ? quotedValue(raw)
      : { value: raw, quote: '' };
    return reQuote(this.learn(value, 'cookie'), quote);
  }
  private nestedScan(text: string): string {
    if (this.#jsonDepth >= 64) this.fail();
    this.#jsonDepth += 1;
    try {
      return this.scan(text);
    } finally {
      this.#jsonDepth -= 1;
    }
  }
  private cookies(value: string, kind: CookieFieldKind): string {
    // Complete cookie/attribute knowledge before retaining the projected header.
    for (const part of cookieParts(value, kind)) {
      const raw = value.slice(part.valueStart, part.valueEnd);
      if (part.attribute) this.nestedScan(raw);
      else this.cookieValue(raw);
    }
    const known =
      applyCredentialSpans(
        [value],
        knownCredentialSpans(value, this.#secrets.values(), kind),
      )[0] ?? '';
    const spans = cookieParts(known, kind).map((part) => {
      const raw = known.slice(part.valueStart, part.valueEnd);
      return {
        start: part.valueStart,
        end: part.valueEnd,
        marker: part.attribute ? this.nestedScan(raw) : this.cookieValue(raw),
      };
    });
    return applyCredentialSpans([known], spans)[0] ?? '';
  }
  private nestedField(parent: string, key: string): string {
    if (key !== 'value' || credentialKind(parent) === null) return key;
    return /authorization/iu.test(parent) ? 'Authorization' : parent;
  }
  private discoverScalar(
    item: string | number,
    field: string,
    score: boolean,
  ): void {
    const kind = credentialKind(field);
    if (typeof item === 'number') {
      if (kind !== null && !score) this.learn(String(item), kind);
      return;
    }
    if (kind !== null) {
      this.mask(
        item,
        /authorization/iu.test(field)
          ? 'authorization'
          : (cookieFieldKind(field) ?? kind),
        true,
      );
      return;
    }
    // JSON and decoded literals must finish the same recognition as projection
    // before any earlier sibling or source can be retained or truncated.
    if (JSON_OPENERS.has(item.trimStart()[0]) || item.includes('"'))
      this.text(item);
    else this.scan(this.knownText(item));
  }
  discover(value: unknown, scores: CredentialScoreMode = false): void {
    this.inspect(value, scores, true);
  }
  validate(value: unknown): void {
    this.inspect(value, false, false);
  }
  private childField(
    field: string,
    key: string,
    array: boolean,
    path: readonly string[],
    context: CredentialScoreContext,
    entry: unknown,
  ): string {
    if (context.extra(path, key, entry)) return 'token';
    if (array || (credentialKind(field) !== null && !context.member(path)))
      return field;
    return this.nestedField(field, key);
  }
  private checkArrayLimit(value: object): void {
    if (Array.isArray(value) && value.length > MAX_NODES) this.fail();
  }
  private inspect(
    value: unknown,
    scores: CredentialScoreMode,
    recognize: boolean,
  ): void {
    if (recognize && scores && typeof value === 'string') {
      this.text(value, scores);
      return;
    }
    const context = scores
      ? new CredentialScoreContext(value, scores)
      : MATERIAL_CONTEXT;
    let nodes = 0;
    let chars = 0;
    const seen = new WeakSet<object>();
    const scalar = (
      item: string | number,
      field: string,
      path: readonly string[],
    ): void => {
      if (typeof item === 'string') chars += item.length;
      if (chars > MAX_TEXT) this.fail();
      if (!recognize) return;
      if (typeof item === 'string' && context.literal(path, item)) return;
      if (typeof item === 'string' && context.system(path)) {
        this.text(item, true);
        return;
      }
      this.discoverScalar(item, field, context.numeric(path));
    };
    const visit = (
      item: unknown,
      field: string,
      depth: number,
      path: readonly string[],
    ): void => {
      nodes += 1;
      if (nodes > MAX_NODES || depth > 64) this.fail();
      if (typeof item === 'string' || typeof item === 'number') {
        scalar(item, field, path);
      } else if (item !== null && typeof item === 'object') {
        if (seen.has(item)) return;
        seen.add(item);
        this.checkArrayLimit(item);
        for (const [key, entry] of Object.entries(item)) {
          visit(key, '', depth + 1, path);
          visit(
            entry,
            this.childField(
              field,
              key,
              Array.isArray(item),
              path,
              context,
              entry,
            ),
            depth + 1,
            context.active ? [...path, key] : path,
          );
        }
        seen.delete(item);
      }
    };
    try {
      visit(value, '', 0, []);
    } catch {
      this.#failed = true;
      throw new Error('credential redaction could not safely process material');
    }
  }
  private scan(text: string): string {
    this.check(text);
    // Protect issued syntax from being re-read as `token:...` inside a marker.
    // Tokens are local and absent from input; only exact tokens are restored.
    let prefix = '\0crd';
    while (text.includes(prefix)) prefix += 'x';
    const replacements = new Map<string, string>();
    const hold = (value: string): string => {
      const token = `${prefix}${String(replacements.size)}\0`;
      replacements.set(token, value);
      return token;
    };
    const protect = (value: string): string =>
      value.replace(MARKER, (marker) => {
        if (!this.isMarker(marker)) return marker;
        return hold(marker);
      });
    const restore = (value: string): string => {
      let restored = value;
      for (const [token, marker] of replacements)
        restored = restored.replaceAll(token, () => marker);
      return restored;
    };
    const mask = (value: string, kind: string): string =>
      protect(this.mask(restore(value), kind));
    const queried = maskCredentialQueries(
      protect(text),
      (value, kind) => this.mask(restore(value), kind),
      hold,
    );
    const masked = maskExplicitFields(maskAuthentication(queried, mask), mask);
    return restore(masked);
  }
  knownText(text: string, field = ''): string {
    this.check(text);
    if (this.#secrets.size === 0) return text;
    return (
      applyCredentialSpans(
        [text],
        knownCredentialSpans(text, this.#secrets.values(), field),
      )[0] ?? ''
    );
  }
  private keyText(key: string, scores: CredentialScoreMode = false): string {
    return credentialKind(key) === null ? this.text(key, scores) : key;
  }
  private jsonText(
    text: string,
    scores: CredentialScoreMode,
  ): string | undefined {
    const first = text.trimStart()[0];
    const candidate = JSON_OPENERS.has(first)
      ? text
      : scores
        ? extractJsonObject(text)
        : text;
    const opening = candidate.trimStart()[0];
    if (!JSON_OPENERS.has(opening)) return undefined;
    let body: unknown;
    try {
      body = JSON.parse(candidate);
    } catch {
      return undefined;
    }
    if (body === null || (typeof body !== 'object' && typeof body !== 'string'))
      return undefined;
    if (this.#jsonDepth >= 64) this.fail();
    this.#jsonDepth += 1;
    try {
      let safe: string;
      if (typeof body === 'string') safe = JSON.stringify(this.text(body));
      else {
        const context = scores
          ? new CredentialScoreContext(body, scores)
          : MATERIAL_CONTEXT;
        const cleaned = this.value(body, scores);
        const spans = jsonCopySpans(candidate, cleaned, (key, path) =>
          context.key(path, key) ? key : this.keyText(key),
        );
        safe = applyCredentialSpans([candidate], spans)[0] ?? '';
      }
      if (candidate === text) return safe;
      const start = text.indexOf(candidate);
      return (
        this.text(text.slice(0, start)) +
        safe +
        this.text(text.slice(start + candidate.length))
      );
    } finally {
      this.#jsonDepth -= 1;
    }
  }
  text(text: string, scores: CredentialScoreMode = false): string {
    this.check(text);
    const exact = this.#secrets.get(text);
    if (exact !== undefined) return exact.marker;
    const json = this.jsonText(text, scores);
    if (json !== undefined) return json;
    // Decode quoted literals for exact known-value matching without exposing a
    // JSON-escaped echo. Unchanged prose/formatting is kept byte-for-byte.
    const context = credentialLiteralContexts(text);
    const quoted = text.replace(
      /"(?:\\.|[^"\\])*"/gu,
      (literal, start: number) => {
        let value: unknown;
        try {
          value = JSON.parse(literal);
        } catch {
          return literal;
        }
        if (typeof value !== 'string') return literal;
        const field = context(start, start + literal.length);
        if (field === null) return literal;
        if (field.length > 0) return this.mask(literal, field);
        if (this.#jsonDepth >= 64) this.fail();
        this.#jsonDepth += 1;
        let cleaned: string;
        try {
          cleaned = this.text(value);
        } finally {
          this.#jsonDepth -= 1;
        }
        return cleaned === value ? literal : JSON.stringify(cleaned);
      },
    );
    return this.knownText(this.scan(this.knownText(quoted)));
  }
  value(value: unknown, scores: CredentialScoreMode = false): unknown {
    this.discover(value, scores);
    const context = scores
      ? new CredentialScoreContext(value, scores)
      : MATERIAL_CONTEXT;
    const seen = new WeakSet<object>();
    let nodes = 0;
    let chars = 0;
    const copy = (
      item: unknown,
      field: string,
      path: readonly string[],
    ): unknown => {
      nodes += 1;
      if (nodes > MAX_NODES) this.fail();
      if (typeof item === 'string') {
        if (context.literal(path, item)) return item;
        const kind = credentialKind(field);
        const cleaned =
          kind === null
            ? this.text(item, context.system(path))
            : this.mask(
                item,
                /authorization/iu.test(field)
                  ? 'authorization'
                  : (cookieFieldKind(field) ?? kind),
                true,
              );
        chars += cleaned.length;
        if (chars > MAX_TEXT) this.fail();
        return cleaned;
      }
      if (
        typeof item === 'number' &&
        credentialKind(field) !== null &&
        !context.numeric(path)
      )
        return this.knownText(String(item));
      if (item === null || typeof item !== 'object') return item;
      if (seen.has(item)) return '[circular]';
      seen.add(item);
      this.checkArrayLimit(item);
      const result = Array.isArray(item)
        ? item.map((entry: unknown, index) =>
            copy(
              entry,
              field,
              context.active ? [...path, String(index)] : path,
            ),
          )
        : uniqueCredentialRecord(
            Object.entries(item).map(([key, entry]) => [
              context.key(path, key) ? key : this.keyText(key),
              copy(
                entry,
                this.childField(field, key, false, path, context, entry),
                context.active ? [...path, key] : path,
              ),
            ]),
          );
      seen.delete(item);
      return result;
    };
    try {
      return copy(value, '', []);
    } catch {
      this.#failed = true;
      throw new Error('credential redaction could not safely process material');
    }
  }
  /** Continuations of ONE logical text only. Independent channels use separate calls. */
  textBlocks(blocks: readonly string[]): string {
    const output = this.textBlockValues(blocks);
    return structuredJson(blocks.join(''))
      ? output.join('')
      : output.join('\n');
  }
  /** Safe copies at the original block indices; a spanning replacement starts in its first block. */
  textBlockValues(blocks: readonly string[]): readonly string[] {
    if (blocks.length > MAX_NODES) this.fail();
    if (blocks.reduce((total, block) => total + block.length, 0) > MAX_TEXT)
      this.fail();
    const joined = blocks.join('');
    const processed = this.text(joined);
    const json = structuredJson(joined);
    if (json && blocks.length === 1) return [processed];
    // Preserve normal block separators; carry a secret spanning a split as one marker.
    const ranges = json
      ? []
      : knownCredentialSpans(joined, this.#secrets.values());
    const context = credentialLiteralContexts(joined);
    ranges.push(
      ...(json
        ? jsonCopySpans(joined, JSON.parse(processed), (key) =>
            this.keyText(key),
          )
        : quotedCredentialSpans(
            joined,
            (decoded, start, end) => {
              const field = context(start, end);
              return field === null
                ? []
                : knownCredentialSpans(decoded, this.#secrets.values(), field);
            },
            MAX_NODES - ranges.length,
          )),
    );
    return applyCredentialSpans(blocks, ranges);
  }
}
