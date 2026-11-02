import type {
  WebBootstrap,
  WebForm,
  WebOpinion,
  WebPoint,
  WebPointSummary,
  WebTransport,
} from './web-types.js';
import { copy } from './web-copy.js';
import { WebRequestError } from './web-errors.js';
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function form(value: unknown): value is WebForm {
  return (
    record(value) &&
    typeof value['pairs'] === 'string' &&
    typeof value['rationale'] === 'string' &&
    typeof value['evidence'] === 'string' &&
    typeof value['author'] === 'string' &&
    [
      '',
      'allow',
      'deny',
      'escalate',
      'insufficient-material',
      'review-failure',
    ].includes(String(value['behaviour'])) &&
    ['confirmed', 'disputed', 'undecidable', 'needs-review'].includes(
      String(value['state']),
    )
  );
}
function summary(value: unknown): value is WebPointSummary {
  return (
    record(value) &&
    typeof value['token'] === 'string' &&
    typeof value['workflow'] === 'number' &&
    typeof value['position'] === 'number' &&
    typeof value['sampled'] === 'boolean' &&
    [
      'unopened',
      'draft',
      'confirmed',
      'disputed',
      'undecidable',
      'needs-review',
      'preparation-failed',
    ].includes(String(value['status']))
  );
}
function point(value: unknown): value is WebPoint {
  return (
    record(value) &&
    summary(value) &&
    typeof value['revision'] === 'number' &&
    typeof value['publicationPending'] === 'boolean' &&
    form(value['form']) &&
    typeof value['hasPredecessor'] === 'boolean' &&
    typeof value['exposed'] === 'boolean' &&
    ['ready', 'preparation-failed'].includes(String(value['preparation'])) &&
    (value['error'] === null || typeof value['error'] === 'string') &&
    Array.isArray(value['changedLines']) &&
    value['changedLines'].every((line: unknown) => typeof line === 'number')
  );
}
function bootstrap(value: unknown): value is WebBootstrap {
  const bands = (data: unknown) =>
    Array.isArray(data) &&
    data.every(
      (band: unknown) =>
        record(band) &&
        typeof band['score'] === 'number' &&
        typeof band['criterion'] === 'string',
    );
  return (
    record(value) &&
    ['blind', 'assisted'].includes(String(value['mode'])) &&
    (value['current'] === null || typeof value['current'] === 'string') &&
    Array.isArray(value['points']) &&
    value['points'].every(summary) &&
    bands(value['risk']) &&
    bands(value['authorization'])
  );
}
function opinions(value: unknown): value is readonly WebOpinion[] {
  return (
    Array.isArray(value) &&
    value.every(
      (item: unknown) =>
        record(item) &&
        typeof item['id'] === 'string' &&
        typeof item['model'] === 'string' &&
        (item['rawResponse'] === null ||
          typeof item['rawResponse'] === 'string') &&
        (item['rationale'] === null || typeof item['rationale'] === 'string') &&
        typeof item['evidence'] === 'string' &&
        typeof item['pairs'] === 'string' &&
        typeof item['complete'] === 'boolean' &&
        [
          '',
          'allow',
          'deny',
          'escalate',
          'insufficient-material',
          'review-failure',
        ].includes(String(item['behaviour'])),
    )
  );
}
export function webTransport(token: string): WebTransport {
  async function request<T>(
    path: string,
    guard: (value: unknown) => value is T,
    body?: unknown,
  ): Promise<T> {
    const response = await fetch(path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        'x-annotation-token': token,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const value: unknown = await response.json();
    if (!response.ok)
      throw new WebRequestError(
        record(value) && value['published'] === true
          ? copy.published
          : record(value) && value['published'] === null
            ? copy.unknown
            : response.status === 409
              ? copy.conflict
              : copy.error,
        record(value) && 'published' in value,
      );
    if (!guard(value)) throw new Error(copy.error);
    return value;
  }
  return {
    bootstrap: () => request('/api/bootstrap', bootstrap),
    point: (token) => request('/api/point', point, { token }),
    save: (value) => request('/api/save', point, value),
    confirm: (value) => request('/api/confirm', point, value),
    opinions: (token) => request('/api/opinions', opinions, { token }),
    rebase: (token, revision) =>
      request('/api/rebase', point, { token, revision }),
  };
}
