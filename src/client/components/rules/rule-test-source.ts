/**
 * Reading the call input a tester sample is imported from.
 *
 * "从调用记录带入" replays the tool input of a call the user already made; it does
 * not rerun that call. The recorded arguments object is kept intact — extracting
 * a command string here would drop fields a rule can select and would change what
 * the tester evaluates.
 *
 * This reads the existing audit log routes; it writes nothing.
 */

import { getJson } from '../../api.js';
import type { SessionKind } from '../../../types.js';
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

/** Read one call's original tool input, unchanged. */
export async function importedSample(callId: string): Promise<ImportedCall> {
  const payload: unknown = await getJson(
    `/log?callId=${encodeURIComponent(callId)}`,
  );
  if (!isRecord(payload)) return { ok: false, code: 'call-invalid' };
  if (payload['ok'] !== true)
    return {
      ok: false,
      code:
        typeof payload['code'] === 'string' ? payload['code'] : 'call-failed',
    };
  const record = payload['record'];
  if (!isRecord(record) || typeof record['tool'] !== 'string')
    return { ok: false, code: 'call-incomplete' };
  const args = record['arguments'];
  return {
    ok: true,
    imported: {
      sample: {
        tool: record['tool'],
        args,
        input: JSON.stringify(args, null, 2),
      },
      identity: record['sessionKind'] === 'subagent' ? 'subagent' : 'main',
      cwd: typeof record['cwd'] === 'string' ? record['cwd'] : null,
    },
  };
}
