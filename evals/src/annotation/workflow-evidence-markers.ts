/** Match exported opaque markers across processes while preserving kind and equality. */
import { CREDENTIAL_MARKER_SOURCE } from '../../../src/reviewer/credential-markers.js';

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function* evidenceMatches(
  quote: string,
  material: string,
  portable: boolean,
): Generator<{ readonly index: number; readonly length: number }> {
  const markers = [
    ...quote.matchAll(new RegExp(CREDENTIAL_MARKER_SOURCE, 'gu')),
  ];
  if (!portable || markers.length === 0) {
    let index = material.indexOf(quote);
    while (index >= 0) {
      yield { index, length: quote.length };
      index = material.indexOf(quote, index + 1);
    }
    return;
  }
  const identities = new Map<string, string>();
  let pattern = '',
    cursor = 0;
  for (const marker of markers) {
    pattern += escape(quote.slice(cursor, marker.index));
    let name = identities.get(marker[0]);
    if (name === undefined) {
      name = `marker${String(identities.size)}`;
      identities.set(marker[0], name);
      const body = escape(marker[0]).replace(/[a-f0-9]{64}/u, '[a-f0-9]{64}');
      pattern += `(?<${name}>${body})`;
    } else pattern += `\\k<${name}>`;
    cursor = marker.index + marker[0].length;
  }
  pattern += escape(quote.slice(cursor));
  for (const match of material.matchAll(new RegExp(pattern, 'gu')))
    if (new Set(Object.values(match.groups ?? {})).size === identities.size)
      yield { index: match.index, length: match[0].length };
}
