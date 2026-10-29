import { parseConfig } from '../config.js';
import {
  evaluateCall,
  evaluationPath,
  parseTestInput,
} from '../rules/match.js';
import { nodeTypes } from '../shell/parse.js';
import type {
  CommandRule,
  RulePath,
  RuleTestResult,
  SessionKind,
} from '../types.js';
import { isRecord } from './common.js';
import { asRuleDraft, jsonResponse, readJsonBody } from './http.js';
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

/** One call the tester evaluates: the tool name and its arguments object. */
interface TestSample {
  readonly tool: string;
  readonly args: unknown;
  readonly input: string;
  /**
   * The working directory the call ran under.
   *
   * Redirect and command resolution depend on it: the gate reads the session's
   * working directory, so a tester that always resolved against the plugin
   * process could report a different rule for the same command. An imported
   * sample carries the recorded cwd; a typed one falls back to the request cwd.
   */
  readonly cwd: string;
}

/**
 * Read one submitted sample.
 *
 * A structured sample names the tool and passes its arguments object verbatim;
 * a bare string keeps the legacy one-line form the CLI and the first prototype
 * used. The two forms share one evaluator, so the caller cannot pick a weaker
 * matcher by choosing a different shape.
 *
 * An explicitly supplied `args: null` is a value, not an omission: `null` and
 * `{}` evaluate differently (`$` selects null itself but nothing from an empty
 * object), so folding the first into the second would evaluate a different call
 * from the one the tester showed. Only a genuinely absent argument falls back.
 */
function asTestSample(value: unknown, fallbackCwd: string): TestSample | null {
  if (typeof value === 'string')
    return {
      ...testSampleOfInput(value),
      input: value,
      cwd: fallbackCwd,
    };
  if (!isRecord(value) || typeof value['tool'] !== 'string') return null;
  const args = suppliedArguments(value);
  const input =
    typeof value['input'] === 'string'
      ? value['input']
      : `${value['tool']}: ${JSON.stringify(args)}`;
  return {
    tool: value['tool'],
    args,
    input,
    cwd: typeof value['cwd'] === 'string' ? value['cwd'] : fallbackCwd,
  };
}

/** The submitted arguments, distinguishing an explicit `null` from absence. */
function suppliedArguments(value: Record<string, unknown>): unknown {
  if (Object.hasOwn(value, 'args')) return value['args'];
  if (Object.hasOwn(value, 'arguments')) return value['arguments'];
  return {};
}

/** The legacy line grammar, reused rather than re-parsed here. */
function testSampleOfInput(input: string): {
  readonly tool: string;
  readonly args: unknown;
} {
  const parsed = parseTestInput(input);
  return { tool: parsed.tool, args: parsed.arguments };
}

/**
 * Shape one evaluation as a tester result.
 *
 * `pathDetail` carries the `RulePath` the string form collapses: the page needs
 * the reason (`unresolved`, `incomplete`, `partial-allow`, `no-match`) to explain
 * a `review(default)` without re-deriving priority. Everything else is the same
 * evaluation the gate uses.
 */
function testResult(
  sample: TestSample,
  rules: readonly CommandRule[],
  identity: SessionKind,
): RuleTestResult & {
  readonly pathDetail: RulePath;
  /**
   * The directory the evaluation actually used.
   *
   * The page shows it: without it a result for `echo x > secret.txt` would look
   * the same whether the redirect resolved against the session directory or the
   * plugin process.
   */
  readonly cwd: string;
} {
  const evaluation = evaluateCall({
    rules,
    tool: sample.tool,
    arguments: sample.args,
    identity,
    workspaceRoot: sample.cwd,
    cwd: sample.cwd,
    parentAuthorizationPresent: null,
    historyTruncated: false,
    overlapsDeniedEffect: false,
  });
  return {
    input: sample.input,
    tool: sample.tool,
    cwd: sample.cwd,
    path: evaluationPath(evaluation),
    pathDetail: evaluation.path,
    rule: evaluation.matches.find((match) => match.effective) ?? null,
    matches: evaluation.matches,
    rules: evaluation.rules,
    parse: {
      status: evaluation.parse.status,
      statements: evaluation.parse.statements,
      nodes: nodeTypes(evaluation.parse),
      completeness: evaluation.parse.completeness,
      opaque: evaluation.parse.opaque,
      unresolved: evaluation.parse.unresolved,
    },
    argv: sample.tool === 'bash' ? evaluation.argv : [],
    // The page shows what was matched and why a word kept its expression, using
    // the same parse the evaluation used.
    normalization: evaluation.normalization,
    shadowed: evaluation.shadowed,
    ...(evaluation.parse.error === undefined
      ? {}
      : { error: evaluation.parse.error }),
  };
}

/** The submitted tester body, once its rule list has been validated. */
interface TestRequest {
  readonly rules: readonly CommandRule[];
  readonly samples: readonly TestSample[];
  readonly identity: SessionKind;
}

/**
 * Read the request body into the call shape the evaluator needs.
 *
 * A rejected body returns a response instead, so the handler keeps one branch
 * per reason instead of mixing parsing with evaluation.
 */
function testRequestOf(
  body: unknown,
  fallbackRules: readonly CommandRule[],
): TestRequest | Response {
  const rawSamples = isRecord(body)
    ? (body['samples'] ?? body['inputs'])
    : undefined;
  if (!Array.isArray(rawSamples)) {
    return jsonResponse(
      {
        ok: false,
        code: 'bad-request',
        message: 'samples or inputs must be an array',
      },
      400,
    );
  }
  // The whole submitted list is validated at once: a duplicate id or an
  // index-dependent path only makes sense across rules, and evaluating a subset
  // would silently disagree with what saving would accept.
  const draft =
    isRecord(body) && body['rules'] !== undefined
      ? asRuleDraft(body['rules'])
      : null;
  if (draft !== null && draft.errors.length > 0)
    return jsonResponse(
      {
        ok: false,
        code: 'invalid-rule',
        message: 'the submitted rules are not valid',
        errors: draft.errors,
      },
      400,
    );
  const requestCwd =
    isRecord(body) && typeof body['cwd'] === 'string'
      ? body['cwd']
      : process.cwd();
  const samples = rawSamples
    .map((value) => asTestSample(value, requestCwd))
    .filter((sample): sample is TestSample => sample !== null);
  if (samples.length !== rawSamples.length) {
    return jsonResponse(
      {
        ok: false,
        code: 'bad-request',
        message: 'every sample needs a tool name or a tester line',
      },
      400,
    );
  }
  const identity = isRecord(body) ? body['identity'] : undefined;
  return {
    rules: draft === null ? fallbackRules : draft.rules,
    samples,
    identity:
      identity === 'subagent' || identity === 'main' ? identity : 'main',
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
      const parsed = testRequestOf(body, runtime.config.rules);
      if (parsed instanceof Response) return parsed;
      const results = parsed.samples.map((sample) =>
        testResult(sample, parsed.rules, parsed.identity),
      );
      return jsonResponse({ ok: true, results });
    },
  };
}
