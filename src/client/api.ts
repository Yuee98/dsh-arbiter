/**
 * Browser-side access to the host half's exact Fetch routes.
 *
 * Every route is owner-only and authenticated by the Web connection cookie;
 * the page never talks to SQLite or the profile file directly.
 */

import type { Decoder } from './decoders/values.js';

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

async function request(path: string, init?: RequestInit): Promise<unknown> {
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
  const value: unknown = JSON.parse(text.trim().length === 0 ? 'null' : text);
  return value;
}

/** A typed result requires a real decoder; ignored/raw payloads stay unknown. */
export function getJson(path: string): Promise<unknown>;
export function getJson<T>(path: string, decode: Decoder<T>): Promise<T>;
export async function getJson(
  path: string,
  decode?: Decoder<unknown>,
): Promise<unknown> {
  const value = await request(path);
  return decode === undefined ? value : decode(value);
}

/**
 * Post with a caller-owned lifetime.
 *
 * The Reviewer connection test is cancellable: aborting the signal stops the
 * fetch, which the host observes and forwards to the in-flight model request.
 * Every other caller keeps the plain `postJson` form.
 */
export function postJsonWithSignal(
  path: string,
  body: unknown,
  signal: AbortSignal,
): Promise<unknown>;
export function postJsonWithSignal<T>(
  path: string,
  body: unknown,
  signal: AbortSignal,
  decode: Decoder<T>,
): Promise<T>;
export async function postJsonWithSignal(
  path: string,
  body: unknown,
  signal: AbortSignal,
  decode?: Decoder<unknown>,
): Promise<unknown> {
  const value = await request(path, {
    method: 'POST',
    body: JSON.stringify(body),
    signal,
  });
  return decode === undefined ? value : decode(value);
}

export function postJson(path: string, body: unknown): Promise<unknown>;
export function postJson<T>(
  path: string,
  body: unknown,
  decode: Decoder<T>,
): Promise<T>;
export async function postJson(
  path: string,
  body: unknown,
  decode?: Decoder<unknown>,
): Promise<unknown> {
  const value = await request(path, {
    method: 'POST',
    body: JSON.stringify(body),
  });
  return decode === undefined ? value : decode(value);
}
