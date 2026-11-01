/** Redact log material before the existing evidence/window readers impose caps. */
import type { CredentialRedactor } from '../reviewer/credential-redactor.js';
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
function contentCopy(content: unknown, redactor: CredentialRedactor): string {
  return textGroups(content)
    .map((group) => redactor.textBlocks(group))
    .join('\n');
}
export function discoverLog(
  log: SessionLog,
  redactor: CredentialRedactor,
): void {
  for (const event of log.events) {
    if (!record(event.data)) continue;
    const data = event.data;
    if (event.type === 'tool/call') redactor.discover(data['arguments']);
    const content = textGroups(data['content']);
    if (record(data['message']))
      content.push(...textGroups(data['message']['content']));
    for (const group of content) redactor.discover(group.join(''));
  }
}
export function redactLog(
  log: SessionLog,
  redactor: CredentialRedactor,
): SessionLog {
  const copy = (event: SessionEventLike): SessionEventLike => {
    if (!record(event.data)) return event;
    const data = event.data;
    const message = data['message'];
    return {
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
  };
  return { ...log, events: log.events.map(copy), own: log.own.map(copy) };
}
