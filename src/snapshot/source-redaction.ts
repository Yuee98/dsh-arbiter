/** Redact log material before the existing evidence/window readers impose caps. */
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
import { structuredJson } from '../reviewer/credential-literals.js';
import type { SessionLog } from './log.js';
import type { SessionEventLike } from './types.js';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function textGroups(content: unknown): string[][] {
  if (typeof content === 'string') return [[content]];
  if (!Array.isArray(content)) return [];
  const groups: string[][] = [];
  let group: string[] = [];
  for (const block of content) {
    if (
      record(block) &&
      block['type'] === 'text' &&
      typeof block['text'] === 'string'
    )
      group.push(block['text']);
    else if (group.length > 0) {
      groups.push(group);
      group = [];
    }
  }
  if (group.length > 0) groups.push(group);
  return groups;
}
/** Text projection of safe source blocks; non-text blocks keep logical streams apart. */
export function sourceContentText(content: unknown): string {
  return textGroups(content)
    .map((group) => {
      const joined = group.join('');
      return structuredJson(joined) ? joined : group.join('\n');
    })
    .join('\n');
}
function contentCopy(content: unknown, redactor: CredentialRedactor): unknown {
  if (typeof content === 'string') return redactor.text(content);
  if (!Array.isArray(content)) return redactor.value(content);
  const result: unknown[] = [];
  let index = 0;
  while (index < content.length) {
    const block: unknown = content[index];
    if (
      !record(block) ||
      block['type'] !== 'text' ||
      typeof block['text'] !== 'string'
    ) {
      result.push(redactor.value(block));
      index += 1;
      continue;
    }
    const group: Record<string, unknown>[] = [];
    const text: string[] = [];
    while (index < content.length) {
      const next: unknown = content[index];
      if (
        !record(next) ||
        next['type'] !== 'text' ||
        typeof next['text'] !== 'string'
      )
        break;
      group.push(next);
      text.push(next['text']);
      index += 1;
    }
    const safe = redactor.textBlockValues(text);
    group.forEach((entry, at) => {
      const metadata = redactor.value(
        Object.fromEntries(
          Object.entries(entry).filter(([key]) => key !== 'text'),
        ),
      );
      if (!record(metadata))
        throw new Error('credential text block could not be safely copied');
      result.push({ ...metadata, text: safe[at] ?? '' });
    });
  }
  return result;
}
function discoverContent(content: unknown, redactor: CredentialRedactor): void {
  for (const group of textGroups(content)) redactor.discover(group.join(''));
  if (!Array.isArray(content)) {
    if (typeof content !== 'string') redactor.discover(content);
    return;
  }
  for (const block of content) {
    redactor.discover(
      record(block) && block['type'] === 'text'
        ? Object.fromEntries(
            Object.entries(block).filter(([key]) => key !== 'text'),
          )
        : block,
    );
  }
}
export function discoverLog(
  log: SessionLog,
  redactor: CredentialRedactor,
): void {
  for (const event of log.events) {
    if (!record(event.data)) continue;
    const data = event.data;
    if (event.type === 'tool/call') redactor.discover(data['arguments']);
    if (data['content'] !== undefined)
      discoverContent(data['content'], redactor);
    if (record(data['message']))
      discoverContent(data['message']['content'], redactor);
  }
}
export function redactLog(
  log: SessionLog,
  redactor: CredentialRedactor,
): SessionLog {
  const copies = new WeakMap<SessionEventLike, SessionEventLike>();
  const copy = (event: SessionEventLike): SessionEventLike => {
    if (!record(event.data)) return event;
    const data = event.data;
    const message = data['message'];
    if (
      event.type !== 'tool/call' &&
      data['content'] === undefined &&
      (!record(message) || message['content'] === undefined)
    )
      return event;
    const previous = copies.get(event);
    if (previous !== undefined) return previous;
    const result = {
      ...event,
      data: {
        ...data,
        ...(event.type !== 'tool/call'
          ? {}
          : { arguments: redactor.value(data['arguments']) }),
        ...(data['content'] === undefined
          ? {}
          : { content: contentCopy(data['content'], redactor) }),
        ...(!record(message) || message['content'] === undefined
          ? {}
          : {
              message: {
                ...message,
                content: contentCopy(message['content'], redactor),
              },
            }),
      },
    };
    copies.set(event, result);
    return result;
  };
  return { ...log, events: log.events.map(copy), own: log.own.map(copy) };
}
