/** Material parsing preserves text/JSON and explicitly omits binary media. */
import type { ReviewMedia, ReviewResultBody } from '../types.js';

export function eventRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function eventJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

export { sourceContentText as eventText } from './source-redaction.js';

function textBlock(
  value: unknown,
): value is Record<string, unknown> & { readonly text: string } {
  return (
    eventRecord(value) &&
    value['type'] === 'text' &&
    typeof value['text'] === 'string'
  );
}

function resultString(value: string, depth: number): unknown {
  const inline = /^data:([^;,]*)([^,]*),/iu.exec(value);
  if (
    inline !== null &&
    (/;base64(?:;|$)/iu.test(inline[2] ?? '') ||
      (inline[1] !== '' && mediaType({ mimeType: inline[1] }) !== null))
  )
    return {
      type: inline[1] || 'media-omitted',
      state: 'omitted',
      note: 'inline media body not provided',
    };
  const parsed = eventJson(value);
  if (!eventRecord(parsed) && !Array.isArray(parsed)) return value;
  const projected = resultContent(parsed, depth + 1);
  return JSON.stringify(projected) === JSON.stringify(parsed)
    ? value
    : JSON.stringify(projected);
}

function resultTextBlock(
  entry: Record<string, unknown> & { readonly text: string },
  projected: unknown,
  depth: number,
): Record<string, unknown> {
  const { text: _text, ...metadata } = entry;
  const safe = resultContent(metadata, depth + 1);
  return {
    ...(eventRecord(safe) ? safe : {}),
    ...(typeof projected === 'string'
      ? { text: projected }
      : eventRecord(projected)
        ? projected
        : {}),
  };
}

function resultArray(value: readonly unknown[], depth: number): unknown[] {
  const result: unknown[] = [];
  let index = 0;
  while (index < value.length) {
    const block = value[index];
    if (!textBlock(block)) {
      result.push(resultContent(block, depth + 1));
      index += 1;
      continue;
    }
    const group: (Record<string, unknown> & { readonly text: string })[] = [];
    const channel = block['channel'];
    while (index < value.length) {
      const next = value[index];
      if (!textBlock(next) || next['channel'] !== channel) break;
      group.push(next);
      index += 1;
    }
    const projected = resultString(
      group.map((entry) => entry.text).join(''),
      depth,
    );
    if (typeof projected !== 'string') {
      result.push(
        ...group.map((entry, at) =>
          resultTextBlock(entry, at === 0 ? projected : '', depth),
        ),
      );
      continue;
    }
    let offset = 0;
    for (const [at, entry] of group.entries()) {
      const text =
        at === group.length - 1
          ? projected.slice(offset)
          : projected.slice(offset, offset + entry.text.length);
      offset += entry.text.length;
      result.push(resultTextBlock(entry, text, depth));
    }
  }
  return result;
}

function encodedBody(value: Record<string, unknown>): boolean {
  return (
    typeof value['encoding'] === 'string' &&
    /^(?:base64|base64url|binary)$/iu.test(value['encoding']) &&
    (typeof value['data'] === 'string' || Array.isArray(value['data']))
  );
}

function mediaType(value: Record<string, unknown>): string | null {
  const type = value['type'];
  const mime =
    value['mimeType'] ??
    value['mime_type'] ??
    (typeof type === 'string' &&
    /^(?:image|audio|video|application)\//iu.test(type)
      ? type
      : undefined);
  if (
    typeof mime === 'string' &&
    !/^(?:text\/|application\/(?:[\w.+-]+\+)?(?:json|xml)(?:;|$))/iu.test(mime)
  )
    return mime;
  if (encodedBody(value)) return 'binary';
  return typeof type === 'string' &&
    /^(?:image|image_url|input_image|audio|input_audio|video|file|attachment|resource|resource_link)$/u.test(
      type,
    )
    ? type
    : null;
}

function reference(value: Record<string, unknown>): string | undefined {
  const nested = [value['image_url'], value['source'], value['resource']].find(
    eventRecord,
  );
  const raw =
    value['ref'] ??
    value['reference'] ??
    value['uri'] ??
    value['url'] ??
    nested?.['url'] ??
    nested?.['uri'] ??
    (typeof value['image_url'] === 'string' ? value['image_url'] : undefined);
  return typeof raw === 'string' && !/^data:/iu.test(raw) ? raw : undefined;
}

function mediaOf(value: Record<string, unknown>, type: string): ReviewMedia {
  const ref = reference(value);
  return {
    type,
    ...(ref === undefined ? {} : { ref }),
    note: 'media body not provided to the text reviewer',
  };
}

function mediaOrigin(value: Record<string, unknown>, depth: number) {
  return Object.fromEntries(
    ['channel', 'source'].flatMap((key) =>
      value[key] === undefined
        ? []
        : [[key, resultContent(value[key], depth + 1)]],
    ),
  );
}

/** Text-only media projection; the caller owns credential discovery/copy order. */
export function resultContent(value: unknown, depth = 0): unknown {
  if (depth > 64) return { omitted: 'structured result nesting limit' };
  if (typeof value === 'string') return resultString(value, depth);
  if (Array.isArray(value)) return resultArray(value, depth);
  if (!eventRecord(value)) return value;
  const type = mediaType(value);
  if (type !== null)
    return {
      ...mediaOf(value, type),
      ...mediaOrigin(value, depth),
      state: 'omitted',
    };
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      resultContent(item, depth + 1),
    ]),
  );
}

function truncationNotes(
  value: unknown,
): { source: 'upstream' | 'collection'; note: string }[] {
  return Array.isArray(value)
    ? value.flatMap(
        (
          item: unknown,
        ): { source: 'upstream' | 'collection'; note: string }[] => {
          if (!eventRecord(item) || typeof item['note'] !== 'string') return [];
          const source = item['source'];
          return source === 'upstream' || source === 'collection'
            ? [{ source, note: item['note'] }]
            : [];
        },
      )
    : [];
}

/** Preserve explicit collection/upstream states rather than inferring success. */
export function resultBody(
  value: unknown,
  options: { readonly deferMedia?: boolean } = {},
): ReviewResultBody {
  if (!eventRecord(value))
    return { state: 'unavailable', reason: 'not-provided' };
  if (value['state'] === 'empty') return { state: 'empty' };
  if (value['state'] === 'unavailable') {
    const reason = value['reason'];
    return {
      state: 'unavailable',
      reason:
        reason === 'unreadable' || reason === 'lost' ? reason : 'not-provided',
    };
  }
  if (value['state'] === 'omitted') {
    const media = value['media'];
    return {
      state: 'omitted',
      media: Array.isArray(media)
        ? media.flatMap((item: unknown) => {
            if (!eventRecord(item) || typeof item['type'] !== 'string')
              return [];
            const ref = reference(item);
            return [
              {
                type: item['type'],
                ...(ref === undefined ? {} : { ref }),
                note:
                  typeof item['note'] === 'string'
                    ? item['note']
                    : 'media body not provided',
              },
            ];
          })
        : [],
    };
  }
  const content = value['content'];
  if (content === undefined)
    return { state: 'unavailable', reason: 'not-provided' };
  if (content === '' || (Array.isArray(content) && content.length === 0))
    return { state: 'empty' };
  const notes = truncationNotes(value['truncations']);
  return {
    state: 'present',
    content: options.deferMedia === true ? content : resultContent(content),
    ...(notes.length === 0 ? {} : { truncations: notes }),
  };
}
