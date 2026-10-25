import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  assertMessageBody,
  assertMessageTitle,
} from '../../scripts/github/message-policy.ts';
import { squashMerge } from '../../scripts/github/squash-merge.ts';

const titleScript = fileURLToPath(
  new URL('../../scripts/check-pr-title.ts', import.meta.url),
);
const head = 'a'.repeat(40);
const pullRequest = {
  title: 'ci: validate PR titles',
  headRefOid: head,
  state: 'OPEN',
  isDraft: false,
};

function githubFixture(
  latest: unknown = pullRequest,
  checks: unknown = [{ name: 'Verify', bucket: 'pass' }],
) {
  return vi
    .fn<(args: string[], input?: string) => string>()
    .mockReturnValueOnce(JSON.stringify(pullRequest))
    .mockReturnValueOnce(JSON.stringify(checks))
    .mockReturnValueOnce(JSON.stringify(latest))
    .mockReturnValueOnce('Merged');
}

describe('shared PR and squash message policy', () => {
  it.each([
    'feat(rules)!: change the rule format',
    'fix: preserve approval decisions',
    'chore(deps-dev): bump @testing-library/jest-dom from 6.9.1 to 7.0.1',
    'ci(ui/i18n): validate locale resources (#28)',
    'revert: undo the runtime update',
  ])('accepts %s', (title) => {
    expect(() => {
      assertMessageTitle(title);
    }).not.toThrow();
  });

  it.each([
    '',
    'ci: 更新规则',
    'ci: update “rules”',
    'CI: validate rules',
    'feature: validate rules',
    'ci: ',
    'ci:  validate rules',
    'ci: validate rules ',
    ' ci: validate rules',
    'ci: validate\nrules',
    'ci: validate\rrules',
    'ci: validate\trules',
    'ci: validate rules\u001b[31m',
    'ci(): validate rules',
    'ci(Invalid Scope): validate rules',
    'ci:validate rules',
  ])('rejects malformed or non-ASCII title %j', (title) => {
    expect(() => {
      assertMessageTitle(title);
    }).toThrow('Use type(scope)!: summary');
  });

  it('allows empty and multiline English bodies, rejecting other characters', () => {
    expect(() => {
      assertMessageBody('');
    }).not.toThrow();
    expect(() => {
      assertMessageBody('Reason\n\n- Preserve history\n\tDetails');
    }).not.toThrow();
    expect(() => {
      assertMessageBody('中文 PR 描述');
    }).toThrow('Squash body');
    expect(() => {
      assertMessageBody('Hidden\u0000content');
    }).toThrow('Squash body');
  });

  it('passes CI metadata through the environment without shell evaluation', () => {
    const title = 'ci: preserve literal $(printf unsafe) and `commands`';
    const result = spawnSync(process.execPath, [titleScript], {
      env: { ...process.env, PR_TITLE: title },
      encoding: 'utf8',
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain(title);
  });

  it('uses the same rejection for the local CLI and CI environment', () => {
    const title = 'ci: 更新规则';
    for (const args of [[], [title]]) {
      const result = spawnSync(process.execPath, [titleScript, ...args], {
        env: { ...process.env, PR_TITLE: title },
        encoding: 'utf8',
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('Use type(scope)!: summary');
    }
  });
});

describe('validated squash merge', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const directory of directories.splice(0)) {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  function bodyFile(body: string) {
    const directory = mkdtempSync(join(tmpdir(), 'arbiter-merge-'));
    directories.push(directory);
    const file = join(directory, 'body.txt');
    writeFileSync(file, body);
    return file;
  }

  it('checks every reported check, rereads the title, and pins the merge head', () => {
    const github = githubFixture({
      ...pullRequest,
      title: 'ci: preserve literal $(printf unsafe)',
    });
    expect(squashMerge(['30'], github)).toBe('Merged');
    expect(github.mock.calls.map(([args]) => args.slice(0, 2))).toEqual([
      ['pr', 'view'],
      ['pr', 'checks'],
      ['pr', 'view'],
      ['pr', 'merge'],
    ]);
    expect(github).toHaveBeenNthCalledWith(2, [
      'pr',
      'checks',
      '30',
      '--json',
      'name,bucket',
    ]);
    expect(github).toHaveBeenLastCalledWith(
      [
        'pr',
        'merge',
        '30',
        '--squash',
        '--match-head-commit',
        head,
        '--subject',
        'ci: preserve literal $(printf unsafe) (#30)',
        '--body-file',
        '-',
      ],
      '',
    );
  });

  it('previews the same message without issuing a merge', () => {
    const github = githubFixture();
    expect(squashMerge(['30', '--dry-run'], github)).toContain(
      'ci: validate PR titles (#30)',
    );
    expect(github).toHaveBeenCalledTimes(3);
  });

  it('passes an explicit English body via stdin, preserving real line breaks', () => {
    const github = githubFixture();
    const body = 'Preserve decisions.\r\n\r\nValidate every title.\r\n';
    squashMerge(['30', '--body-file', bodyFile(body)], github);
    expect(github.mock.lastCall?.[1]).toBe(body.replace(/\r\n/gu, '\n'));
  });

  it('rejects a Chinese body before any GitHub request', () => {
    const github = githubFixture();
    expect(() =>
      squashMerge(['30', '--body-file', bodyFile('中文')], github),
    ).toThrow('Squash body');
    expect(github).not.toHaveBeenCalled();
  });

  it('rejects a title edited after the previous CI run', () => {
    const github = githubFixture({ ...pullRequest, title: 'ci: 更新规则' });
    expect(() => squashMerge(['30'], github)).toThrow(
      'Use type(scope)!: summary',
    );
    expect(github).toHaveBeenCalledTimes(3);
  });

  it('rejects a changed head rather than merging untested new commits', () => {
    const github = githubFixture({
      ...pullRequest,
      headRefOid: 'b'.repeat(40),
    });
    expect(() => squashMerge(['30'], github)).toThrow('PR head changed');
    expect(github).toHaveBeenCalledTimes(3);
  });

  it.each([
    null,
    { ...pullRequest, state: 'MERGED' },
    { ...pullRequest, isDraft: true },
    { ...pullRequest, headRefOid: '--admin' },
    { ...pullRequest, title: 123 },
  ])('rejects an invalid or unmergeable PR: %j', (data) => {
    const github = vi.fn().mockReturnValue(JSON.stringify(data));
    expect(() => squashMerge(['30'], github)).toThrow(
      'Expected an open, ready PR',
    );
    expect(github).toHaveBeenCalledTimes(1);
  });

  it('does not merge when checks fail or are still pending', () => {
    const github = vi
      .fn<(args: string[], input?: string) => string>()
      .mockReturnValueOnce(JSON.stringify(pullRequest))
      .mockImplementationOnce(() => {
        throw new Error('Checks pending');
      });
    expect(() => squashMerge(['30'], github)).toThrow('Checks pending');
    expect(github).toHaveBeenCalledTimes(2);
  });

  it.each(['cancel', 'fail', 'pending', 'skipping', 'unknown'])(
    'rejects %s even if gh returns exit success and required Verify passes',
    (bucket) => {
      const github = githubFixture(pullRequest, [
        { name: 'Verify', bucket: 'pass' },
        { name: 'Real DSH smoke (ubuntu-24.04)', bucket },
      ]);
      expect(() => squashMerge(['30'], github)).toThrow(
        'All reported checks must pass',
      );
      expect(github).toHaveBeenCalledTimes(2);
    },
  );

  it.each([null, [], {}, [{ name: 'Verify' }], [{ bucket: 'pass' }]])(
    'rejects missing or malformed check results: %j',
    (checks) => {
      const github = githubFixture(pullRequest, checks);
      expect(() => squashMerge(['30'], github)).toThrow(
        'All reported checks must pass',
      );
      expect(github).toHaveBeenCalledTimes(2);
    },
  );

  it('accepts successful required checks and independent smoke together', () => {
    const github = githubFixture(pullRequest, [
      { name: 'Verify', bucket: 'pass' },
      { name: 'PR title', bucket: 'pass' },
      { name: 'Real DSH smoke (ubuntu-24.04)', bucket: 'pass' },
    ]);
    expect(squashMerge(['30', '--dry-run'], github)).toContain(
      'Dry run: squash',
    );
    expect(github).toHaveBeenCalledTimes(3);
  });

  it.each([
    { args: [], reason: 'Usage:' },
    { args: ['0'], reason: 'Usage:' },
    { args: ['--admin'], reason: 'Unknown option' },
    { args: ['30', '--auto'], reason: 'Unknown option' },
    { args: ['30', '31'], reason: 'Usage:' },
  ])(
    'rejects missing numbers and unsupported merge overrides: %j',
    ({ args, reason }) => {
      const github = githubFixture();
      expect(() => squashMerge(args, github)).toThrow(reason);
      expect(github).not.toHaveBeenCalled();
    },
  );
});
