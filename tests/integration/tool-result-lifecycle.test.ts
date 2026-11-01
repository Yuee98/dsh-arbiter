import { execFile, execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { buildSync } from 'esbuild';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { resultFixture, resultObservation } from './tool-result-helpers.js';

let fixture: ReturnType<typeof resultFixture>;
beforeEach(() => {
  fixture = resultFixture();
});
afterEach(() => {
  fixture.close();
});
const execFileAsync = promisify(execFile);
function bundle(): string {
  const outfile = join(fixture.root, 'audit.cjs');
  buildSync({
    entryPoints: [
      fileURLToPath(new URL('../../src/audit.ts', import.meta.url)),
    ],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    logLevel: 'silent',
  });
  return outfile;
}
const child = `
const { AuditStore } = require(process.argv[1]);
const store = new AuditStore(process.argv[2], JSON.parse(process.argv[3]));
const observation = JSON.parse(process.argv[4]);
const outcome = store.saveToolResult(observation);
const saved = store.getToolResult(observation.sessionId, observation.callId);
console.log(JSON.stringify({ outcome, saved }));
store.close();
`;
function childResult(text: string): Record<string, unknown> {
  const value: unknown = JSON.parse(text);
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('invalid child result');
  return { ...value };
}
function childArgs(entry: string, callId: string): string[] {
  const observation = resultObservation({
    callId,
    parts: [
      {
        kind: 'text',
        channel: 'stdout',
        text: `password=restart-secret\n${'x'.repeat(70_000)}`,
      },
    ],
  });
  return [
    '--no-warnings',
    '-e',
    child,
    entry,
    fixture.path,
    JSON.stringify(DEFAULT_CONFIG.audit),
    JSON.stringify(observation),
  ];
}

describe('tool result observation lifecycle', () => {
  test('PLAN-B01: a genuine new process treats retransmission as unverified, preserving the original receipt and body', () => {
    const store = fixture.open();
    const observation = resultObservation({
      parts: [
        {
          kind: 'text',
          channel: 'stdout',
          text: `password=restart-secret\n${'x'.repeat(70_000)}`,
        },
      ],
    });
    const first = store.saveToolResult(observation);
    const original = store.getToolResult('session', 'query');
    store.close();
    const entry = bundle();
    const repeated = childResult(
      execFileSync(process.execPath, childArgs(entry, 'query'), {
        encoding: 'utf8',
      }),
    );
    expect(repeated['outcome']).toEqual({
      state: 'already-recorded',
      receipt: first.receipt,
      equivalence: 'unverified',
      reason: 'attempted-payload-not-written',
    });
    expect(repeated['saved']).toEqual(original);
    const fresh = childResult(
      execFileSync(process.execPath, childArgs(entry, 'fresh-process-call'), {
        encoding: 'utf8',
      }),
    );
    expect(fresh['outcome']).toMatchObject({ state: 'saved' });
    expect(fresh['saved']).not.toEqual(original);
    const reopened = fixture.open();
    const other = reopened.getToolResult('session', 'fresh-process-call');
    expect(other.fragments[0]?.text).not.toEqual(original.fragments[0]?.text);
    expect(reopened.getToolResult('session', 'query')).toEqual(original);
    expect(readdirSync(`${fixture.path}.results`)).toHaveLength(2);
  });

  test('same-process identical and conflicting payloads are explicitly rejected without a new row or file', () => {
    const store = fixture.open();
    const first = store.saveToolResult(
      resultObservation({
        parts: [{ kind: 'text', channel: 'stdout', text: 'a'.repeat(70_000) }],
      }),
    );
    const original = store.getToolResult('session', 'query');
    const follower = fixture.open();
    const repeated = follower.saveToolResult(resultObservation());
    expect(repeated).toEqual({
      state: 'already-recorded',
      receipt: first.receipt,
      equivalence: 'unverified',
      reason: 'attempted-payload-not-written',
    });
    expect(follower.getToolResult('session', 'query')).toEqual(original);
    expect(readdirSync(`${fixture.path}.results`)).toHaveLength(1);
  });

  test('separate processes serialize publication of the same result identity', async () => {
    fixture.open().close();
    const entry = bundle();
    const results = await Promise.all([
      execFileAsync(process.execPath, childArgs(entry, 'concurrent'), {
        encoding: 'utf8',
      }),
      execFileAsync(process.execPath, childArgs(entry, 'concurrent'), {
        encoding: 'utf8',
      }),
    ]);
    const outcomes = results.map(
      (result) => childResult(result.stdout)['outcome'],
    );
    expect(outcomes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ state: 'saved' }),
        expect.objectContaining({
          state: 'already-recorded',
          equivalence: 'unverified',
        }),
      ]),
    );
    expect(readdirSync(`${fixture.path}.results`)).toHaveLength(1);
    expect(fixture.open().getToolResult('session', 'concurrent').state).toBe(
      'found',
    );
  });

  test('rejects an already expired observation without publishing a body', () => {
    const store = fixture.open();
    expect(
      store.saveToolResult(
        resultObservation({ observedAt: Date.now() - 31 * 86_400_000 }),
      ).state,
    ).toBe('expired');
    expect(store.getToolResult('session', 'query').state).toBe('absent');
    expect(store.recoverToolResults()).toEqual({
      ok: true,
      removed: 0,
      cleanupPending: false,
    });
  });
});
