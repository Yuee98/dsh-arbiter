/**
 * Browser-side access to the host half's exact Fetch routes.
 *
 * Every route is owner-only and authenticated by the Web connection cookie;
 * the page never talks to SQLite or the profile file directly.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly payload: unknown;

  constructor(status: number, payload: unknown, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = codeOf(payload) ?? 'request-failed';
    this.payload = payload;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function codeOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload['code'] === 'string' ? payload['code'] : null;
}

function messageOf(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  return typeof payload['message'] === 'string' ? payload['message'] : null;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('accept', 'application/json');
  if (init?.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`/api/arbiter${path}`, {
    credentials: 'include',
    cache: 'no-store',
    ...init,
    headers,
  });
  const text = await response.text();
  if (!response.ok) {
    let payload: unknown = null;
    if (text.trim().length > 0) {
      try {
        payload = JSON.parse(text) as unknown;
      } catch {
        payload = { message: text };
      }
    }
    const message =
      messageOf(payload) ??
      `Arbiter request failed (${String(response.status)})`;
    throw new ApiError(response.status, payload, message);
  }
  const value: T = JSON.parse(text.trim().length === 0 ? 'null' : text);
  return value;
}

export function getJson<T>(path: string): Promise<T> {
  return request<T>(path);
}

export function postJson<T>(path: string, body: unknown): Promise<T> {
  return request<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
