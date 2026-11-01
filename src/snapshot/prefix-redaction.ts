/** Payload projection through the shared workflow redactor; identity stays native. */
import type {
  ReviewEvent,
  ReviewEventSource,
  ReviewEventSources,
  ReviewPrefix,
  ReviewResultBody,
} from '../types.js';
import {
  discoverSourceContent,
  redactSourceContent,
} from './source-redaction.js';
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';

function material(event: ReviewEvent): unknown {
  if (event.kind === 'call') return [event.arguments, event.cwd];
  if (event.kind === 'result') return event.body;
  if (event.kind === 'settlement') return null;
  return [
    event.text,
    event.kind === 'human' ? event.binding?.question : undefined,
  ];
}

function bodyCopy(
  body: ReviewResultBody,
  redactor: CredentialRedactor,
): ReviewResultBody {
  if (body.state === 'present')
    return {
      ...body,
      content: redactSourceContent(body.content, redactor),
      ...(body.truncations === undefined
        ? {}
        : {
            truncations: body.truncations.map((entry) => ({
              ...entry,
              note: redactor.text(entry.note),
            })),
          }),
    };
  if (body.state !== 'omitted') return body;
  return {
    ...body,
    media: body.media.map((entry) => ({
      ...entry,
      type: redactor.text(entry.type),
      note: redactor.text(entry.note),
      ...(entry.ref === undefined ? {} : { ref: redactor.text(entry.ref) }),
    })),
  };
}

function eventCopy(
  event: ReviewEvent,
  redactor: CredentialRedactor,
): ReviewEvent {
  if (event.kind === 'call')
    return {
      ...event,
      arguments: redactor.value(event.arguments),
      ...(event.cwd === undefined ? {} : { cwd: redactor.text(event.cwd) }),
    };
  if (event.kind === 'result')
    return {
      ...event,
      body: bodyCopy(event.body, redactor),
      ...(event.call?.cwd === undefined
        ? {}
        : { call: { ...event.call, cwd: redactor.text(event.call.cwd) } }),
    };
  if (event.kind === 'settlement') return event;
  return {
    ...event,
    text: redactor.text(event.text),
    ...(event.kind === 'human' && event.binding?.question !== undefined
      ? {
          binding: {
            ...event.binding,
            question: redactor.text(event.binding.question),
          },
        }
      : {}),
  };
}

function sourceCopy(
  source: ReviewEventSource,
  redactor: CredentialRedactor,
): ReviewEventSource {
  return {
    status: {
      ...source.status,
      reason:
        source.status.reason === null
          ? null
          : redactor.text(source.status.reason),
      ...(source.status.protectedOriginalMissing === undefined
        ? {}
        : {
            protectedOriginalMissing: redactor.text(
              source.status.protectedOriginalMissing,
            ),
          }),
    },
    events: source.events.map((event) => eventCopy(event, redactor)),
  };
}

export function redactEventSources(
  sources: ReviewEventSources,
  redactor: CredentialRedactor,
): ReviewEventSources {
  for (const source of [sources.local, sources.parent]) {
    for (const event of source?.events ?? []) {
      if (event.kind === 'result' && event.body.state === 'present')
        discoverSourceContent(event.body.content, redactor);
    }
  }
  redactor.discover([
    sources.local.events.map(material),
    sources.parent?.events.map(material),
    sources.local.status.reason,
    sources.parent?.status.reason,
  ]);
  return {
    local: sourceCopy(sources.local, redactor),
    parent:
      sources.parent === null ? null : sourceCopy(sources.parent, redactor),
  };
}

export function redactPrefix(
  prefix: ReviewPrefix,
  redactor: CredentialRedactor,
): ReviewPrefix {
  return {
    ...redactEventSources(prefix, redactor),
    omissions: prefix.omissions.map((entry) => ({
      ...entry,
      reason: redactor.text(entry.reason),
    })),
  };
}
