import { parseConfig } from '../config.js';
import { runReviewerProbe } from '../reviewer.js';
import { isRecord } from './common.js';
import { jsonResponse, readJsonBody } from './http.js';
import type { FetchRouteLike, HostEnvironment } from './types.js';

/** Largest accepted draft body; a reviewer draft is far smaller than this. */
const MAX_BODY_BYTES = 256 * 1024;

/** A draft section is validated by the same parser the save path uses. */
function draftOf(body: unknown): Record<string, unknown> | null {
  if (!isRecord(body)) return null;
  const candidate = body['draft'];
  if (!isRecord(candidate)) return null;
  return {
    reviewer: candidate['reviewer'],
    policy: candidate['policy'],
  };
}

/**
 * Run one Reviewer connection test against the draft that was on screen.
 *
 * The draft arrives in the request instead of being read from the effective
 * configuration, so the operator can test a route before saving it. Nothing here
 * applies configuration: no config editor write, no audit row, no review count,
 * no breaker update, no approval request. A completed probe is always HTTP 200
 * even when it failed, because a failed connection is the answer this route
 * exists to report; only a malformed request is a transport error.
 *
 * The request's own aborted signal is forwarded to the provider call, so closing
 * the dialog or dropping the connection cancels the model request.
 */
export function reviewerTestRoute(host: HostEnvironment): FetchRouteLike {
  return {
    path: `/api/arbiter/reviewer-test`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const declared = Number(request.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        return jsonResponse(
          { ok: false, code: 'bad-request', message: 'draft is too large' },
          400,
        );
      }
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return jsonResponse(
          { ok: false, code: 'bad-request', message: String(error) },
          400,
        );
      }
      const draft = draftOf(body);
      if (draft === null) {
        return jsonResponse(
          {
            ok: false,
            code: 'bad-request',
            message: 'draft must carry a reviewer and policy section',
          },
          400,
        );
      }
      const parsed = parseConfig(draft);
      if (parsed.errors.length > 0) {
        return jsonResponse(
          {
            ok: false,
            code: 'draft-invalid',
            errors: parsed.errors,
          },
          422,
        );
      }
      const controller = new AbortController();
      const abort = (): void => {
        controller.abort();
      };
      if (request.signal.aborted) abort();
      else request.signal.addEventListener('abort', abort, { once: true });
      try {
        const probe = await runReviewerProbe({
          config: parsed.config,
          llm: host.services.llm,
          credentials: host.services.credentials,
          fetch: globalThis.fetch,
          signal: controller.signal,
        });
        return jsonResponse({ ok: true, probe });
      } finally {
        request.signal.removeEventListener('abort', abort);
      }
    },
  };
}
