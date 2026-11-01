import { randomUUID } from 'node:crypto';
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config.js';
import {
  resultFile,
  resultFixture,
  resultObservation,
} from './tool-result-helpers.js';

let fixture: ReturnType<typeof resultFixture>;
beforeEach(() => {
  fixture = resultFixture();
});
afterEach(() => {
  fixture.close();
});
function largeResult() {
  return resultObservation({
    parts: [
      { kind: 'text', channel: 'stdout', text: 'safe-body\n'.repeat(8000) },
    ],
  });
}

describe('tool result recovery', () => {
  test('distinguishes missing and corrupt files from observed empty content after restart', () => {
    const store = fixture.open();
    expect(store.saveToolResult(largeResult()).state).toBe('saved');
    const saved = store.getToolResult('session', 'query');
    const file = resultFile(saved, fixture.path);
    const original = readFileSync(file);
    unlinkSync(file);
    store.close();
    const restarted = fixture.open();
    const missing = restarted.getToolResult('session', 'query');
    expect(missing.state).toBe('missing-file');
    expect(missing.metadata?.sha256).toBe(saved.metadata?.sha256);
    expect(missing.fragments).toEqual([]);
    writeFileSync(file, original.subarray(1));
    expect(restarted.getToolResult('session', 'query').state).toBe(
      'unreadable',
    );
    writeFileSync(file, Buffer.alloc(original.length, 120));
    expect(restarted.getToolResult('session', 'query').state).toBe(
      'unreadable',
    );
    writeFileSync(file, original);
    expect(restarted.getToolResult('session', 'query').state).toBe('found');
  });

  test('reclaims interrupted owned temporary and published orphan files without deleting unrelated files', () => {
    const store = fixture.open();
    store.saveToolResult(largeResult());
    const retained = resultFile(
      store.getToolResult('session', 'query'),
      fixture.path,
    );
    store.close();
    const directory = `${fixture.path}.results`;
    const temporary = join(directory, `${randomUUID()}.tmp`);
    const orphan = join(directory, `${randomUUID()}.body`);
    const unrelated = join(directory, 'user-notes.txt');
    const misleading = join(directory, `${'-'.repeat(36)}.body`);
    for (const file of [temporary, orphan, unrelated, misleading])
      writeFileSync(file, 'safe interrupted content');
    const restarted = fixture.open();
    expect(existsSync(temporary)).toBe(false);
    expect(existsSync(orphan)).toBe(false);
    expect(existsSync(unrelated)).toBe(true);
    expect(existsSync(misleading)).toBe(true);
    expect(existsSync(retained)).toBe(true);
    expect(restarted.getToolResult('session', 'query').state).toBe('found');
  });

  test('publishes owner-only files and never follows a substituted symlink', () => {
    const store = fixture.open();
    store.saveToolResult(largeResult());
    const result = store.getToolResult('session', 'query');
    const file = resultFile(result, fixture.path);
    expect(
      process.platform === 'win32' || (statSync(file).mode & 0o777) === 0o600,
    ).toBe(true);
    expect(
      process.platform === 'win32' ||
        (statSync(`${fixture.path}.results`).mode & 0o777) === 0o700,
    ).toBe(true);
    const outside = join(fixture.root, 'unrelated-secret');
    writeFileSync(outside, 'outside sentinel');
    unlinkSync(file);
    symlinkSync(outside, file);
    expect(store.getToolResult('session', 'query').state).toBe('unreadable');
    expect(store.clearCalls().ok).toBe(true);
    expect(readFileSync(outside, 'utf8')).toBe('outside sentinel');
    expect(existsSync(file)).toBe(false);
  });

  test('rejects database references escaping the body directory and reports incomplete cleanup', () => {
    const store = fixture.open();
    store.saveToolResult(largeResult());
    const outside = join(fixture.root, 'outside');
    writeFileSync(outside, 'leave intact');
    const db = new DatabaseSync(fixture.path);
    db.exec("UPDATE tool_results SET file_ref = '../outside'");
    expect(store.getToolResult('session', 'query').state).toBe('unreadable');
    expect(store.clearCalls().ok).toBe(false);
    expect(readFileSync(outside, 'utf8')).toBe('leave intact');
    expect(store.health().lastError).toBe('result-cleanup-pending');
    db.exec('DELETE FROM tool_result_garbage');
    db.close();
    expect(store.recoverToolResults().ok).toBe(true);
  });

  test('keeps publication failure visible and reclaims a file published before SQL rollback', () => {
    const store = fixture.open();
    const db = new DatabaseSync(fixture.path);
    db.exec(
      "CREATE TRIGGER deny_publish BEFORE UPDATE ON tool_results WHEN NEW.storage = 'file' BEGIN SELECT RAISE(ABORT, 'synthetic publication failure'); END",
    );
    expect(store.saveToolResult(largeResult()).state).toBe('failed');
    expect(store.getToolResult('session', 'query').state).toBe(
      'storage-failed',
    );
    expect(readdirSync(`${fixture.path}.results`)).toHaveLength(1);
    db.exec('DROP TRIGGER deny_publish');
    db.close();
    store.close();
    const restarted = fixture.open();
    expect(readdirSync(`${fixture.path}.results`)).toEqual([]);
    expect(restarted.getToolResult('session', 'query').state).toBe(
      'storage-failed',
    );
    expect(restarted.saveToolResult(largeResult()).state).toBe('saved');
  });

  test('contains actual filesystem write failure and permits a later retry', () => {
    const store = fixture.open();
    // A non-directory at the controlled root deterministically rejects file publication.
    writeFileSync(`${fixture.path}.results`, 'blocked root');
    expect(store.saveToolResult(largeResult()).state).toBe('failed');
    expect(store.health().state).toBe('degraded');
    expect(readFileSync(`${fixture.path}.results`, 'utf8')).toBe(
      'blocked root',
    );
    unlinkSync(`${fixture.path}.results`);
    expect(store.saveToolResult(largeResult()).state).toBe('saved');
  });

  test('refuses a real previous shape without changing its database or existing body files', () => {
    const store = fixture.open();
    store.saveToolResult(largeResult());
    const body = resultFile(
      store.getToolResult('session', 'query'),
      fixture.path,
    );
    store.close();
    const previous = new DatabaseSync(fixture.path);
    previous.exec(
      "DROP TABLE tool_results; DROP TABLE tool_result_garbage; DELETE FROM meta WHERE key = 'tool-result-generation'; PRAGMA user_version = 3",
    );
    previous.close();
    const database = readFileSync(fixture.path);
    const content = readFileSync(body);
    const refused = fixture.open();
    expect(refused.paused).toBe(true);
    expect(refused.saveToolResult(largeResult()).state).toBe('unavailable');
    expect(refused.recoverToolResults().ok).toBe(false);
    refused.close();
    expect(readFileSync(fixture.path)).toEqual(database);
    expect(readFileSync(body)).toEqual(content);
  });

  test('keeps disabled and closed writes inert while explicit clear can reclaim earlier content', () => {
    const store = fixture.open();
    store.saveToolResult(largeResult());
    store.updateConfig({ ...DEFAULT_CONFIG.audit, enabled: false });
    expect(
      store.saveToolResult(resultObservation({ callId: 'disabled' })).state,
    ).toBe('unavailable');
    expect(store.getToolResult('session', 'disabled').state).toBe('absent');
    expect(store.clearCalls().ok).toBe(true);
    expect(readdirSync(`${fixture.path}.results`)).toEqual([]);
    store.close();
    expect(store.saveToolResult(resultObservation()).state).toBe('unavailable');
    expect(store.getToolResult('session', 'query').state).toBe('unavailable');
  });

  test('fails closed on a huge input or throwing property without leaking the thrown message', () => {
    const store = fixture.open();
    expect(
      store.saveToolResult(
        resultObservation({
          parts: [
            {
              kind: 'text',
              channel: 'stdout',
              text: 'x'.repeat(17 * 1024 * 1024),
            },
          ],
        }),
      ).state,
    ).toBe('failed');
    const secret = 'never-retain-thrown-secret';
    const value = Object.defineProperty({}, 'password', {
      enumerable: true,
      get() {
        throw new Error(secret);
      },
    });
    expect(
      store.saveToolResult(
        resultObservation({
          callId: 'getter',
          parts: [{ kind: 'json', channel: 'structured', value }],
        }),
      ).state,
    ).toBe('failed');
    expect(
      JSON.stringify(store.getToolResult('session', 'getter')),
    ).not.toContain(secret);
    expect(store.health().lastError).not.toContain(secret);
    expect(existsSync(`${fixture.path}.results`)).toBe(false);
  });
});
