import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const script = fileURLToPath(
  new URL('../../tooling/ci/dsh-platforms.mjs', import.meta.url),
);
const all = ['ubuntu-24.04', 'macos-15', 'windows-2025'];
let root: string;
let base: string;

function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function write(path: string, text: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text);
}

function commit(): string {
  git('add', '--all', '--force');
  git('commit', '--quiet', '-m', 'Test fixture');
  return git('rev-parse', 'HEAD');
}

function select(event: string, extra: NodeJS.ProcessEnv = {}) {
  const output = join(root, 'output');
  const result = spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      GITHUB_OUTPUT: output,
      DSH_E2E_EVENT: event,
      DSH_E2E_BASE_SHA: base,
      DSH_E2E_PLATFORMS: '',
      ...extra,
    },
  });
  return {
    ...result,
    output: existsSync(output) ? readFileSync(output, 'utf8') : '',
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'arbiter-dsh-platforms-'));
  git('init', '--quiet', '--initial-branch=main');
  git('config', 'user.name', 'Fixture');
  git('config', 'user.email', 'fixture@example.invalid');
  git('config', 'commit.gpgsign', 'false');
  git('config', 'core.hooksPath', join(root, 'no-hooks'));
  write('README.md', 'Fixture\n');
  write('tests/e2e/runtime/package.json', '{"version":"0.1.0"}\n');
  write('tests/e2e/runtime/package-lock.json', '{"lockfileVersion":3}\n');
  base = commit();
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('DSH E2E platform selection', () => {
  it.each([...all, 'all'])(
    'respects the explicit manual choice %s',
    (requested) => {
      const result = select('workflow_dispatch', {
        DSH_E2E_PLATFORMS: requested,
      });
      expect(result.status).toBe(0);
      expect(result.output).toContain(
        `platforms=${JSON.stringify(requested === 'all' ? all : [requested])}\n`,
      );
      expect(result.output).toContain('reason=manual\n');
    },
  );

  it('keeps main on Ubuntu even when the host runtime changed', () => {
    write('tests/e2e/runtime/package.json', '{"version":"0.2.0"}\n');
    commit();
    const result = select('push', { DSH_E2E_PLATFORMS: 'all' });
    expect(result.status).toBe(0);
    expect(result.output).toBe(
      'platforms=["ubuntu-24.04"]\nreason=main-push\n',
    );
  });

  it('keeps an ordinary UI PR on Ubuntu', () => {
    write('src/client/view.tsx', 'export const View = () => null;\n');
    commit();
    const result = select('pull_request');
    expect(result.status).toBe(0);
    expect(result.output).toBe(
      'platforms=["ubuntu-24.04"]\nreason=related-pr\n',
    );
  });

  it.each(['dependabot[bot]', 'maintainer'])(
    'runs three platforms for a runtime update by %s',
    (actor) => {
      write('tests/e2e/runtime/package.json', '{"version":"0.2.0"}\n');
      commit();
      const result = select('pull_request', {
        GITHUB_ACTOR: actor,
        GITHUB_HEAD_REF: 'arbitrary-branch-name',
      });
      expect(result.status).toBe(0);
      expect(result.output).toBe(
        `platforms=${JSON.stringify(all)}\nreason=runtime-change\n`,
      );
    },
  );

  it('uses the entire PR diff when the latest commit only changes UI', () => {
    write('tests/e2e/runtime/package-lock.json', '{"lockfileVersion":4}\n');
    commit();
    write('src/client/view.tsx', 'export const View = () => null;\n');
    commit();
    const result = select('pull_request');
    expect(result.status).toBe(0);
    expect(result.output).toContain(`platforms=${JSON.stringify(all)}\n`);
  });

  it.each(['delete', 'rename'])(
    'detects a runtime manifest %s as well as edits',
    (operation) => {
      const file = join(root, 'tests/e2e/runtime/package.json');
      if (operation === 'delete') rmSync(file);
      else renameSync(file, join(root, 'moved-package.json'));
      commit();
      const result = select('pull_request');
      expect(result.status).toBe(0);
      expect(result.output).toContain('reason=runtime-change\n');
      expect(result.output).toContain(`platforms=${JSON.stringify(all)}\n`);
    },
  );

  it('does not split a newline in an unrelated filename into a runtime path', () => {
    write('notes\ntests/e2e/runtime/package.json', 'Unrelated content\n');
    commit();
    const result = select('pull_request');
    expect(result.status).toBe(0);
    expect(result.output).toContain('platforms=["ubuntu-24.04"]\n');
  });

  it.each(['', 'abcd123', 'a'.repeat(40) + '\nplatforms=all'])(
    'fails rather than downgrading a PR with an invalid base: %j',
    (sha) => {
      const result = select('pull_request', { DSH_E2E_BASE_SHA: sha });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('full pull request base SHA');
      expect(result.output).toBe('');
    },
  );

  it('rejects an unknown manual platform', () => {
    const result = select('workflow_dispatch', { DSH_E2E_PLATFORMS: 'other' });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported platform');
    expect(result.output).toBe('');
  });

  it('rejects an event outside the workflow contract', () => {
    const result = select('pull_request_target');
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('Unsupported event');
    expect(result.output).toBe('');
  });
});
