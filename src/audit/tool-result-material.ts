import { createHash } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import type {
  ToolResultMetadata,
  ToolResultObservation,
  ToolResultPart,
} from './tool-result-types.js';
import { credentialRegistry } from '../reviewer/credential-registry.js';
import { validateResultJson } from './tool-result-json.js';
import { MAX_RESULT_BYTES, sliceResultBody } from './tool-result-slicing.js';

function textGroups(
  parts: readonly ToolResultPart[],
): readonly (readonly number[])[] {
  const groups: number[][] = [];
  parts.forEach((part, index) => {
    if (part.kind !== 'text') return;
    const previous = parts[index - 1];
    if (
      part.continuation === true &&
      previous?.kind === 'text' &&
      previous.channel === part.channel
    )
      groups.at(-1)?.push(index);
    else groups.push([index]);
  });
  return groups;
}
function groupTexts(
  parts: readonly ToolResultPart[],
  group: readonly number[],
): readonly string[] {
  return group.map((index) => {
    const part = parts[index];
    if (part?.kind !== 'text') throw new Error('invalid-result-material');
    return part.text;
  });
}
function safeTexts(
  parts: readonly ToolResultPart[],
  redactor: CredentialRedactor,
): readonly string[] {
  const groups = textGroups(parts);
  // Discover spanning credentials in every continuation before projecting ANY channel.
  for (const group of groups)
    redactor.textBlockValues(groupTexts(parts, group));
  const texts = parts.map((part) =>
    part.kind === 'json' ? JSON.stringify(redactor.value(part.value)) : '',
  );
  for (const group of groups) {
    const safe = redactor.textBlockValues(groupTexts(parts, group));
    group.forEach((index, position) => {
      texts[index] = safe[position] ?? '';
    });
  }
  return texts;
}
function mediaReference(
  reference: string | undefined,
  redactor: CredentialRedactor,
): string | null {
  if (reference === undefined) return null;
  // URL parsing ignores ASCII tabs/newlines, including inside a data: scheme.
  const inline = /^[\p{Cc}\s]*d[\t\r\n]*a[\t\r\n]*t[\t\r\n]*a[\t\r\n]*:/iu.test(
    reference,
  );
  return inline ? null : redactor.text(reference);
}
export function prepareToolResult(
  db: DatabaseSync,
  observation: ToolResultObservation,
): {
  readonly metadata: ToolResultMetadata;
  readonly body: Buffer;
} {
  validateResultJson(observation);
  const redactor = credentialRegistry(db, db.location())
    .context(observation.sessionId, observation.parentSession)
    .fork();
  redactor.discover(observation);
  const texts = safeTexts(observation.parts, redactor);
  const sliced = sliceResultBody(texts);
  let offset = 0;
  const parts = observation.parts.map((part, index) => {
    const bytes = Buffer.byteLength(texts[index] ?? '');
    const start = offset;
    offset += bytes;
    return {
      channel: redactor.text(part.channel),
      source:
        part.kind === 'media'
          ? mediaReference(part.source, redactor)
          : part.source === undefined
            ? null
            : redactor.text(part.source),
      kind: part.kind,
      start,
      bytes,
      mediaType: part.kind === 'media' ? redactor.text(part.mediaType) : null,
      reference:
        part.kind === 'media' ? mediaReference(part.reference, redactor) : null,
    };
  });
  const metadata: ToolResultMetadata = {
    version: 1,
    processingVersion: 'tool-result-v1',
    status: observation.status,
    contentState: observation.contentState,
    observedAt: observation.observedAt,
    callStartedAt: observation.callStartedAt ?? null,
    unavailableReason:
      observation.unavailableReason === undefined
        ? null
        : redactor.text(observation.unavailableReason),
    upstreamTruncated: observation.upstreamTruncated ?? false,
    localTruncation:
      sliced.sourceBytes > MAX_RESULT_BYTES ? 'collection-limit' : null,
    sourceBytes: sliced.sourceBytes,
    retainedBytes: sliced.body.length,
    sha256: createHash('sha256').update(sliced.body).digest('hex'),
    ranges: sliced.fragments.map(({ start, end }) => ({ start, end })),
    parts,
    origin: {
      eventId: observation.eventId ?? null,
      seq: observation.seq ?? null,
      turnId: observation.turnId ?? null,
      invocation:
        observation.invocation === undefined
          ? null
          : redactor.value(observation.invocation),
    },
  };
  // Metadata is bounded too; no unbounded side channel beside the body cap.
  if (Buffer.byteLength(JSON.stringify(metadata)) > MAX_RESULT_BYTES)
    throw new Error('invalid-result-material');
  return { metadata, body: sliced.body };
}
