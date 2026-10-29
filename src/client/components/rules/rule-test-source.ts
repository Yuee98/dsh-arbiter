/**
 * Reading the call input a tester sample is imported from.
 *
 * "从调用记录带入" replays the tool input of a call the user already made; it does
 * not rerun that call. The recorded arguments object is kept intact — extracting
 * a command string here would drop fields a rule can select and would change what
 * the tester evaluates.
 *
 * This reads the same `/log` route the shared call detail uses and decodes it
 * with that route's own decoder. Hand-reading a second, private shape here is
 * what once made the importer answer `call-incomplete` for every real record:
 * the route publishes a decoded detail, not a bare stored row.
 *
 * It writes nothing.
 */

import { getJson } from '../../api.js';
import { callDetailResponse } from '../../decoders/logs.js';
import type { SessionKind } from '../../../types.js';
import type { CallDetailView } from '../../view-types.js';
import type { TestSample } from './rule-test-model.js';

/** One recorded call the tester can replay. */
export interface ImportableCall {
  readonly callId: string;
  readonly ts: number;
  readonly tool: string;
  readonly command?: string | undefined;
}

/**
 * A replayable sample, including the context the call was judged under.
 *
 * `cwd` and `identity` are part of the evaluation input, not presentation: a
 * relative redirect resolves against the recorded cwd, and a rule may be scoped
 * to one session kind. Dropping either would let the tester answer a different
 * question from the one the gate answered.
 */
export interface ImportedTestSample {
  readonly sample: TestSample;
  readonly identity: SessionKind;
  readonly cwd: string | null;
}

export type ImportedCall =
  | { readonly ok: true; readonly imported: ImportedTestSample }
  | { readonly ok: false; readonly code: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export type RecentCalls =
  | { readonly ok: true; readonly calls: readonly ImportableCall[] }
  | { readonly ok: false; readonly code: string };

/**
 * The calls the tester offers to import.
 *
 * A composition without audit storage answers `audit-unavailable`; that is a
 * distinct state from "no calls yet", so it is reported instead of an empty list.
 */
export async function recentCalls(): Promise<RecentCalls> {
  const payload: unknown = await getJson('/logs?limit=20');
  if (!isRecord(payload)) return { ok: false, code: 'audit-invalid' };
  if (payload['ok'] !== true)
    return {
      ok: false,
      code:
        typeof payload['code'] === 'string' ? payload['code'] : 'audit-failed',
    };
  const rows = Array.isArray(payload['rows']) ? payload['rows'] : [];
  const calls: ImportableCall[] = [];
  for (const row of rows) {
    if (!isRecord(row)) continue;
    const callId = row['callId'];
    const tool = row['tool'];
    if (typeof callId !== 'string' || typeof tool !== 'string') continue;
    const command =
      typeof row['command'] === 'string' && row['command'].trim().length > 0
        ? row['command']
        : undefined;
    calls.push({
      callId,
      ts: typeof row['ts'] === 'number' ? row['ts'] : 0,
      tool,
      ...(command === undefined ? {} : { command }),
    });
  }
  return { ok: true, calls };
}

/**
 * Read one call's original tool input, unchanged.
 *
 * The arguments come from the detail's raw layer, which is the stored object
 * rather than a rendering of it. A record that kept no input answers
 * `call-incomplete`: the tester cannot replay a call whose input nobody stored.
 */
export async function importedSample(callId: string): Promise<ImportedCall> {
  let detail: CallDetailView;
  try {
    detail = await getJson(
      `/log?callId=${encodeURIComponent(callId)}`,
      callDetailResponse,
    );
  } catch (error) {
    return { ok: false, code: codeOfFailure(error) };
  }
  if (detail.unreadable) return { ok: false, code: 'call-unreadable' };
  if (detail.overview.tool.length === 0)
    return { ok: false, code: 'call-incomplete' };
  const args = detail.raw.arguments;
  if (args === undefined || args === null)
    return { ok: false, code: 'call-incomplete' };
  return {
    ok: true,
    imported: {
      sample: {
        tool: detail.overview.tool,
        args,
        input: JSON.stringify(args, null, 2),
      },
      identity:
        detail.overview.sessionKind === 'subagent' ? 'subagent' : 'main',
      cwd: detail.overview.cwd,
    },
  };
}

/**
 * The stable code a failed read reports.
 *
 * `getJson` throws an `ApiError` carrying the route's own reason; any other
 * failure is a malformed answer rather than a missing record.
 */
function codeOfFailure(error: unknown): string {
  if (error !== null && typeof error === 'object') {
    const code: unknown = Reflect.get(error, 'code');
    if (typeof code === 'string' && code.length > 0) return code;
  }
  return 'call-invalid';
}
