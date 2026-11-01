/** Schema vocabulary is protocol; defaults/examples and annotation text are material. */
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import {
  credentialKind,
  type CredentialKind,
} from '../reviewer/credential-fields.js';
import { uniqueCredentialRecord } from '../reviewer/credential-record.js';

const TYPES = new Set([
  'null',
  'boolean',
  'object',
  'array',
  'number',
  'string',
  'integer',
]);
// The vocabularies declared by the installed Ajv draft-07/2019/2020 meta-schemas.
const KEYWORDS = new Set(
  `$anchor $comment $data $defs $dynamicAnchor $dynamicRef $id $recursiveAnchor $recursiveRef $ref $schema $vocabulary additionalItems additionalProperties allOf anyOf const contains contentEncoding contentMediaType contentSchema default definitions dependencies dependentRequired dependentSchemas deprecated description else enum examples exclusiveMaximum exclusiveMinimum format if items maxContains maxItems maxLength maxProperties maximum minContains minItems minLength minProperties minimum multipleOf not oneOf pattern patternProperties prefixItems properties propertyNames readOnly required then title type unevaluatedItems unevaluatedProperties uniqueItems writeOnly`.split(
    ' ',
  ),
);
const MAPS = new Set([
  'properties',
  'patternProperties',
  '$defs',
  'definitions',
  'dependentSchemas',
  'dependencies',
]);
const CHILDREN = new Set([
  'additionalItems',
  'additionalProperties',
  'allOf',
  'anyOf',
  'contains',
  'contentSchema',
  'else',
  'if',
  'items',
  'not',
  'oneOf',
  'prefixItems',
  'propertyNames',
  'then',
  'unevaluatedItems',
  'unevaluatedProperties',
]);
const LITERALS = new Set(['default', 'const', 'enum', 'examples']);
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function propertyName(name: string, redactor: CredentialRedactor): string {
  return credentialKind(name) === null ? redactor.knownText(name) : name;
}
function propertyNames(value: unknown, redactor: CredentialRedactor): unknown {
  return Array.isArray(value) &&
    value.every((entry: unknown) => typeof entry === 'string')
    ? value.map((entry: string) => propertyName(entry, redactor))
    : redactor.value(value);
}
function typeValue(value: unknown, redactor: CredentialRedactor): unknown {
  if (typeof value === 'string' && TYPES.has(value)) return value;
  if (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) => typeof entry === 'string' && TYPES.has(entry),
    )
  )
    return value.map((entry: unknown) => entry);
  return redactor.value(value);
}
type Walk = (value: unknown, kind: CredentialKind | null) => unknown;
function member(
  key: string,
  item: unknown,
  kind: CredentialKind | null,
  redactor: CredentialRedactor,
  walk: Walk,
): unknown {
  if (MAPS.has(key) && object(item))
    return uniqueCredentialRecord(
      Object.entries(item).map(([name, schema]) => [
        propertyName(name, redactor),
        key === 'dependencies' && Array.isArray(schema)
          ? propertyNames(schema, redactor)
          : walk(
              schema,
              key === 'properties' ? (credentialKind(name) ?? kind) : kind,
            ),
      ]),
    );
  if (LITERALS.has(key))
    return kind === null
      ? redactor.value(item)
      : redactor.sensitiveValue(item, kind);
  if (key === 'type') return typeValue(item, redactor);
  if (key === 'required') return propertyNames(item, redactor);
  if (key === 'dependentRequired' && object(item))
    return uniqueCredentialRecord(
      Object.entries(item).map(([name, names]) => [
        propertyName(name, redactor),
        propertyNames(names, redactor),
      ]),
    );
  return CHILDREN.has(key) ? walk(item, kind) : redactor.value(item);
}
export function copyArgumentsSchema(
  value: unknown,
  redactor: CredentialRedactor,
  kind: CredentialKind | null = null,
  state = { active: new WeakSet<object>(), nodes: 0 },
  depth = 0,
): unknown {
  state.nodes += 1;
  if (state.nodes > 100_000 || depth > 64)
    throw new Error('credential schema material limit exceeded');
  if (value === null || typeof value !== 'object') return redactor.value(value);
  if (state.active.has(value))
    throw new Error('credential schema material could not be safely processed');
  state.active.add(value);
  try {
    const walk: Walk = (item, fieldKind) =>
      copyArgumentsSchema(item, redactor, fieldKind, state, depth + 1);
    if (Array.isArray(value))
      return value.map((item: unknown) => walk(item, kind));
    return uniqueCredentialRecord(
      Object.entries(value).map(([key, item]) => [
        KEYWORDS.has(key) ? key : redactor.knownText(key),
        member(key, item, kind, redactor, walk),
      ]),
    );
  } finally {
    state.active.delete(value);
  }
}
export function discoverSchemaCredentials(
  value: unknown,
  redactor: CredentialRedactor,
): void {
  // Reuse the exact bounded schema semantics for knowledge. This transient result
  // is discarded; only a second projection after all discovery can reach SQLite.
  copyArgumentsSchema(value, redactor);
}
