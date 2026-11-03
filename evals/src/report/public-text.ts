/** One bounded credential vocabulary; only text is projected, never numeric metrics. */
import { CredentialRedactor } from '../../../src/reviewer/credential-redactor.js';

// These fields are closed protocol values, not quoted user text. Their spelling
// cannot become a credential occurrence merely because a rationale quotes it.
const CLOSED_FIELDS = new Set([
  'formatVersion',
  'source',
  'status',
  'kind',
  'protocol',
  'protocols',
  'transport',
  'classification',
  'settlement',
  'word',
  'verdict',
  'reference',
  'basis',
  'mode',
  'channel',
  'labels',
  'conditionSelection',
  'generation',
  'archiveCommit',
  'evidenceAccess',
  'axis',
  'standing',
  'branch',
  'split',
  'labelStatus',
  'caseFactsSource',
  'outcomeStatus',
  'challengeClass',
  'origin',
  'provenance',
  'costStatus',
  'indexStatus',
  'recordStatus',
  'field',
  'outcome',
  'behaviour',
  'behaviourReference',
  'actual',
  'evidence',
  'actualContinuation',
  'redaction',
  'configEvidence',
  'cacheRead',
  'cacheWrite',
  'reasoning',
  'name',
]);
// Report objects and fixed counter maps own their field names. Only this
// schema-declared dictionary uses free-text reasons as keys.
const DYNAMIC_KEYS = new Set(['excludedByReason']);
const CLOSED_GROUP_AXES = new Set([
  'content-set',
  'reference-source',
  'split',
  'protocol',
  'challenge',
  'provenance',
]);
const CANDIDATE_AXES = new Set(['prompt', 'structure', 'history', 'scale']);
// The replay writer emits this finite protocol explanation. Its closed modes
// are not an authentication field; appended or adjacent prose remains untrusted.
const N0_MODES = ['strict', 'at-least'] as const;
const N0_NOTES = new Set(
  N0_MODES.flatMap((risk) =>
    N0_MODES.map(
      (authorization) =>
        `N0 risk=${risk}, authorization=${authorization}; score, authorization-demand and verdict changes are separate observations.`,
    ),
  ),
);
function closedProtocolNote(key: string, value: string): boolean {
  return key === 'notes' && N0_NOTES.has(value);
}
const IDENTITIES = new Set([
  'cellId',
  'caseId',
  'rootId',
  'pointId',
  'viewId',
  'lineageId',
  'targetId',
  'group',
  'key',
]);

function closedGroupKey(value: object, name: string): boolean {
  const axis: unknown = Reflect.get(value, 'axis');
  return (
    name === 'key' && typeof axis === 'string' && CLOSED_GROUP_AXES.has(axis)
  );
}

function closedCandidateAxis(value: object, name: string): boolean {
  return Reflect.has(value, 'candidateId') && CANDIDATE_AXES.has(name);
}

function strings(
  value: unknown,
  visit: (key: string, text: string) => void,
  key = '',
): void {
  if (typeof value === 'string') visit(key, value);
  else if (Array.isArray(value))
    for (const entry of value) strings(entry, visit, key);
  else if (value !== null && typeof value === 'object')
    for (const [name, entry] of Object.entries(value)) {
      if (DYNAMIC_KEYS.has(key)) visit('', name);
      strings(
        entry,
        visit,
        closedGroupKey(value, name) || closedCandidateAxis(value, name)
          ? 'axis'
          : name,
      );
    }
}

export function publicReport<
  T extends { readonly run: { readonly runId: string } },
>(report: T, credentialEvidence?: unknown): T {
  const redactor = new CredentialRedactor(
    `report-publication:${report.run.runId}`,
  );
  let unavailable = false;
  const fields = new Map<string, string>();
  try {
    if (credentialEvidence !== undefined) redactor.value(credentialEvidence);
    strings(report, (key, text) => {
      if (CLOSED_FIELDS.has(key) || closedProtocolNote(key, text)) return;
      const identity = JSON.stringify([key, text]);
      if (fields.has(identity)) return;
      const cleaned = redactor.value({ [key]: text });
      const value: unknown =
        cleaned !== null && typeof cleaned === 'object'
          ? Object.values(cleaned)[0]
          : null;
      fields.set(
        identity,
        typeof value === 'string' && value === text ? text : '[redacted]',
      );
    });
  } catch {
    unavailable = true;
  }
  if (unavailable)
    throw new Error(
      'public report credential recognition unavailable; publication refused',
    );
  const identities = new Map<string, string>();
  const text = (key: string, value: string): string => {
    if (CLOSED_FIELDS.has(key) || closedProtocolNote(key, value)) return value;
    try {
      return fields.get(JSON.stringify([key, value])) === '[redacted]' ||
        redactor.text(value) !== value
        ? '[redacted]'
        : value;
    } catch {
      return '[unavailable]';
    }
  };
  const project = (value: unknown, parent = ''): void => {
    if (value === null || typeof value !== 'object') return;
    const entries = Object.entries(value);
    const names = entries.map(([name]) =>
      !Array.isArray(value) && DYNAMIC_KEYS.has(parent) ? text('', name) : name,
    );
    if (new Set(names).size !== entries.length)
      throw new Error(
        'public report text keys collide after redaction; publication refused',
      );
    if (names.some((name, index) => name !== entries[index]?.[0]))
      for (const [name] of entries) Reflect.deleteProperty(value, name);
    for (const [index, [name, entry]] of entries.entries()) {
      const target = names[index];
      if (target === undefined) throw new Error('missing public field');
      const field = Array.isArray(value) ? parent : name;
      const cleaned: unknown =
        typeof entry === 'string'
          ? closedGroupKey(value, name) || closedCandidateAxis(value, name)
            ? entry
            : text(field, entry)
          : entry;
      if (
        typeof entry === 'string' &&
        cleaned !== entry &&
        IDENTITIES.has(field)
      ) {
        const identity = JSON.stringify([field, cleaned]);
        const previous = identities.get(identity);
        if (previous !== undefined && previous !== entry)
          throw new Error(
            'public identifiers collide after redaction; publication refused',
          );
        identities.set(identity, entry);
      }
      project(cleaned, field);
      Reflect.set(value, target, cleaned);
    }
  };
  const result = structuredClone(report);
  project(result);
  return result;
}
