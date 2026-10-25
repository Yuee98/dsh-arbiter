import { parseConfig } from '../config.js';
import type { CommandRule } from '../types.js';

export function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
    },
  });
}

export function readJsonBody(request: Request): Promise<unknown> {
  return request
    .text()
    .then((text) =>
      text.trim().length === 0 ? {} : (JSON.parse(text) as unknown),
    );
}

export function asRule(value: unknown): CommandRule | null {
  const parsed = parseConfig({ rules: [value] });
  if (parsed.errors.length > 0) return null;
  return parsed.config.rules[0] ?? null;
}
