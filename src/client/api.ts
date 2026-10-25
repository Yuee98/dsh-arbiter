/**
 * Browser-side access to the host half's exact Fetch routes.
 *
 * Every route is owner-only and authenticated by the Web connection cookie;
 * the page never talks to SQLite or the profile file directly.
 */

import { sessionAdmissionResponse } from './decoders/admission.js';
import type { Decoder } from './decoders/values.js';
import type {
  AdmissionAction,
  SessionAdmissionResponse,
} from './view-types.js';

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

/** Read with a caller-owned lifetime, for a request a component may cancel. */
export function getJsonWithSignal(
  path: string,
  signal: AbortSignal,
  decode: Decoder<unknown>,
): Promise<unknown> {
  return request(path, { signal }).then((value) => decode(value));
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

/**
 * One session's admission, as the backend confirmed it.
 *
 * A 404/409 answer is a refusal in the same shape as a decoded body, so the
 * caller handles both transports through one branch; a malformed success body
 * still throws, because it is not an answer at all.
 */
export async function getAdmission(
  sessionId: string,
  signal?: AbortSignal,
): Promise<SessionAdmissionResponse> {
  const path = `/sessions?sessionId=${encodeURIComponent(sessionId)}`;
  try {
    if (signal === undefined) {
      return await getJson(path, sessionAdmissionResponse);
    }
    return sessionAdmissionResponse(
      await getJsonWithSignal(path, signal, (value) => value),
    );
  } catch (error) {
    return refusalOrThrow(error);
  }
}

/**
 * Ask the backend to enable or disable one session.
 *
 * The body never carries a boundary: the execution boundary is a plugin
 * configuration setting, and the route rejects a per-session override instead
 * of silently ignoring it.
 */
export async function setAdmission(
  sessionId: string,
  action: AdmissionAction,
  signal?: AbortSignal,
): Promise<SessionAdmissionResponse> {
  try {
    if (signal === undefined) {
      return await postJson(
        '/sessions',
        { sessionId, action },
        sessionAdmissionResponse,
      );
    }
    const value: unknown = await postJsonWithSignal(
      '/sessions',
      { sessionId, action },
      signal,
    );
    return sessionAdmissionResponse(value);
  } catch (error) {
    return refusalOrThrow(error);
  }
}

/** A refused answer becomes a refusal; anything else is rethrown as-is. */
function refusalOrThrow(error: unknown): SessionAdmissionResponse {
  const refusal = refusalOf(error);
  if (refusal !== null) return refusal;
  throw error instanceof Error ? error : new Error(String(error));
}

/**
 * Convert a refused HTTP answer into the admission refusal shape.
 *
 * The route answers `{ok:false, code, message, revision}` with a 4xx status, so
 * the body is already the refusal; `request()` throws before the decoder runs.
 * Anything without that body (a network failure, a proxy error page) stays a
 * thrown error so it is not mistaken for a host decision.
 */
function refusalOf(error: unknown): SessionAdmissionResponse | null {
  if (!(error instanceof ApiError)) return null;
  const payload: unknown = error.payload;
  if (payload === null || typeof payload !== 'object') return null;
  if (Reflect.get(payload, 'ok') !== false) return null;
  try {
    return sessionAdmissionResponse(payload);
  } catch {
    return null;
  }
}
