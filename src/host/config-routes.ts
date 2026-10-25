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

export function credentialsRoute(host: HostEnvironment): FetchRouteLike {
  const { runtime } = host;
  return {
    path: `/api/arbiter/credentials`,
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const credentials = host.services.credentials;
      const ref = runtime.config.reviewer.decision.apiKeyRef;
      if (credentials === undefined) {
        return jsonResponse({
          ok: true,
          ref,
          configured: false,
          source: null,
          supported: false,
        });
      }
      try {
        const info = await credentials.describe?.(ref);
        return jsonResponse({
          ok: true,
          ref,
          configured: info?.configured ?? false,
          source: info?.source ?? null,
          supported: true,
        });
      } catch (error) {
        return jsonResponse({
          ok: false,
          ref,
          configured: false,
          source: null,
          supported: true,
          message: error instanceof Error ? error.message : String(error),
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
