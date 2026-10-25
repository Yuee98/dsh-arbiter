import { parseConfig } from '../config.js';
import { testRules } from '../rules/match.js';
import { isRecord } from './common.js';
import { asRule, jsonResponse, readJsonBody } from './http.js';
import type { HostEnvironment, FetchRouteLike } from './types.js';

export function validateRoute(): FetchRouteLike {
  return {
    path: `/api/arbiter/validate`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return jsonResponse(
          { ok: false, code: 'bad-request', message: String(error) },
          400,
        );
      }
      if (!isRecord(body) || !isRecord(body['config'])) {
        return jsonResponse(
          {
            ok: false,
            code: 'bad-request',
            message: 'config must be an object',
            errors: [
              {
                path: '',
                message: 'config must be an object',
                code: 'config.not-object',
              },
            ],
            warnings: [],
          },
          400,
        );
      }
      const candidate = parseConfig(body['config']);
      return jsonResponse({
        ok: candidate.errors.length === 0,
        errors: candidate.errors,
        warnings: candidate.warnings,
      });
    },
  };
}

/** Longest credential reference the status query accepts; references are names. */
const MAX_REFERENCE_LENGTH = 200;

/**
 * The reference the status query describes.
 *
 * The page asks about the draft's reference because a save may not have run
 * yet. The value is used exactly as the running Reviewer uses it: the decision
 * backend resolves `reviewer.decision.apiKeyRef` verbatim, so trimming here
 * would report another reference's status. An omitted query value asks for the
 * effective configuration; an explicit empty or oversized one is a reference
 * this host cannot describe, which is not another reference's state.
 */
type AskedReference =
  | { readonly kind: 'effective' }
  | { readonly kind: 'exact'; readonly ref: string }
  | { readonly kind: 'empty' }
  | { readonly kind: 'unusable' };

function askedReference(request: Request): AskedReference {
  const asked = new URL(request.url).searchParams.get('ref');
  if (asked === null) return { kind: 'effective' };
  if (asked.length === 0) return { kind: 'empty' };
  if (asked.length > MAX_REFERENCE_LENGTH) return { kind: 'unusable' };
  return { kind: 'exact', ref: asked };
}

/**
 * Report whether one credential reference is configured.
 *
 * `state` is the answer the page renders, and it deliberately separates the
 * cases a boolean would merge: `unsupported` means this composition cannot
 * describe references at all, `unavailable` means this one could not be
 * described. Neither may be shown as "unset". Only presence and its source
 * leave the host: `describe` returns no value, and a thrown provider error
 * becomes a stable code instead of its message.
 */
export function credentialsRoute(host: HostEnvironment): FetchRouteLike {
  const { runtime } = host;
  return {
    path: `/api/arbiter/credentials`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      const asked = askedReference(request);
      if (asked.kind === 'unusable') {
        // Not a reference this host can describe, and reflecting arbitrary
        // input back to the page serves nothing.
        return jsonResponse({
          ok: true,
          state: 'unavailable',
          code: 'credentials-unavailable',
          ref: '',
          configured: false,
          source: null,
          supported: true,
        });
      }
      const ref =
        asked.kind === 'effective'
          ? runtime.config.reviewer.decision.apiKeyRef
          : asked.kind === 'empty'
            ? ''
            : asked.ref;
      const describe = host.services.credentials?.describe?.bind(
        host.services.credentials,
      );
      if (describe === undefined) {
        return jsonResponse({
          ok: true,
          state: 'unsupported',
          ref,
          configured: false,
          source: null,
          supported: false,
        });
      }
      if (ref.length === 0) {
        // The decision backend resolves nothing for an empty reference, so this
        // is an unconfigured state rather than an unknown one.
        return jsonResponse({
          ok: true,
          state: 'unconfigured',
          ref,
          configured: false,
          source: null,
          supported: true,
        });
      }
      try {
        const info = await describe(ref);
        return jsonResponse({
          ok: true,
          state: info.configured ? 'configured' : 'unconfigured',
          ref,
          configured: info.configured,
          source: info.source ?? null,
          supported: true,
        });
      } catch {
        return jsonResponse({
          ok: false,
          state: 'unavailable',
          code: 'credentials-unavailable',
          ref,
          configured: false,
          source: null,
          supported: true,
        });
      }
    },
  };
}

export function testRoute(host: HostEnvironment): FetchRouteLike {
  const { runtime } = host;
  return {
    path: `/api/arbiter/test`,
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let body: unknown;
      try {
        body = await readJsonBody(request);
      } catch (error) {
        return jsonResponse(
          { ok: false, code: 'bad-request', message: String(error) },
          400,
        );
      }
      if (!isRecord(body) || !Array.isArray(body['inputs'])) {
        return jsonResponse(
          {
            ok: false,
            code: 'bad-request',
            message: 'inputs must be an array',
          },
          400,
        );
      }
      const rules = Array.isArray(body['rules'])
        ? body['rules'].flatMap((value) => {
            const rule = asRule(value);
            return rule === null ? [] : [rule];
          })
        : runtime.config.rules;
      const cwd = typeof body['cwd'] === 'string' ? body['cwd'] : process.cwd();
      const results = body['inputs']
        .filter((input): input is string => typeof input === 'string')
        .map((input) =>
          testRules(input, rules, {
            identity: 'main',
            workspaceRoot: cwd,
            cwd,
          }),
        );
      return jsonResponse({ ok: true, results });
    },
  };
}
