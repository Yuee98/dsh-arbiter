/**
 * Credential removal on the detail read path.
 *
 * The view is the only place stored request material becomes visible, so this
 * pins the two rules that keep a credential out of it: an auth-shaped field is
 * masked whatever it holds, and a scheme token inside free text is masked even
 * when no field name precedes it. Ordinary material must survive untouched —
 * over-masking would hide the very evidence the view exists to show.
 */

import { describe, expect, test } from 'vitest';

import { scrubText, scrubValue } from '../../src/host/call-detail-redact.js';

describe('scrubText', () => {
  test('masks a field assignment with its whole value', () => {
    expect(scrubText('Authorization: Bearer abc123')).toBe(
      'Authorization: [redacted]',
    );
    expect(scrubText('{"authorization":"Bearer abc123"}')).toBe(
      '{"authorization":[redacted]}',
    );
    expect(scrubText('X-Api-Key = sk-live-1234')).toBe(
      'X-Api-Key = [redacted]',
    );
  });

  test('masks a scheme token with no field name', () => {
    expect(scrubText('sent Bearer abcd1234ef to the proxy')).toBe(
      'sent Bearer [redacted] to the proxy',
    );
  });

  test('leaves ordinary material and model text alone', () => {
    const text = 'the reviewer returned {"risk":9,"authorized":1}';
    expect(scrubText(text)).toBe(text);
  });

  test('does not treat a bare word as a credential', () => {
    expect(scrubText('authorization is required')).toBe(
      'authorization is required',
    );
  });
});

describe('scrubValue', () => {
  test('masks auth fields at every depth and keeps other values', () => {
    const value = scrubValue({
      request: {
        model: 'clef-flash',
        headers: { Authorization: 'Bearer abc', accept: 'application/json' },
      },
      attempts: [{ cookie: 'session=abc' }],
    });
    expect(value).toEqual({
      request: {
        model: 'clef-flash',
        headers: { Authorization: '[redacted]', accept: 'application/json' },
      },
      attempts: [{ cookie: '[redacted]' }],
    });
  });

  test('reports a cycle instead of recursing forever', () => {
    const cyclic: Record<string, unknown> = { model: 'x' };
    cyclic['self'] = cyclic;
    expect(scrubValue(cyclic)).toEqual({ model: 'x', self: '[circular]' });
  });

  test('masks a scheme token inside a nested string', () => {
    expect(
      scrubValue({ error: 'proxy said Authorization: Basic dXNlcjpwYXNz' }),
    ).toEqual({ error: 'proxy said Authorization: [redacted]' });
  });
});
