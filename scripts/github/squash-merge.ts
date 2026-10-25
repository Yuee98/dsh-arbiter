import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import process from 'node:process';
import { parseArgs } from 'node:util';

import { assertMessageBody, assertMessageTitle } from './message-policy.ts';

type GitHub = (args: string[], input?: string) => string;

function runGitHub(args: string[], input?: string): string {
  const result = spawnSync('gh', args, {
    encoding: 'utf8',
    input,
    env: { ...process.env, GH_PROMPT_DISABLED: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `gh ${args.slice(0, 2).join(' ')} failed: ${result.stderr || result.stdout}`,
    );
  }
  return result.stdout;
}

function readPullRequest(pr: string, github: GitHub) {
  const data: unknown = JSON.parse(
    github(['pr', 'view', pr, '--json', 'title,headRefOid,state,isDraft']),
  );
  if (
    !data ||
    typeof data !== 'object' ||
    !('title' in data) ||
    typeof data.title !== 'string' ||
    !('headRefOid' in data) ||
    typeof data.headRefOid !== 'string' ||
    !/^[a-f0-9]{40}$/u.test(data.headRefOid) ||
    !('state' in data) ||
    data.state !== 'OPEN' ||
    !('isDraft' in data) ||
    data.isDraft !== false
  ) {
    throw new Error('Expected an open, ready PR with a valid head commit.');
  }
  return { title: data.title, head: data.headRefOid };
}

export function squashMerge(
  args: string[],
  github: GitHub = runGitHub,
): string {
  const { values, positionals } = parseArgs({
    args,
    allowPositionals: true,
    options: {
      'dry-run': { type: 'boolean', default: false },
      'body-file': { type: 'string' },
    },
  });
  const [pr] = positionals;
  if (positionals.length !== 1 || !pr || !/^[1-9][0-9]*$/u.test(pr)) {
    throw new Error(
      'Usage: pnpm pr:merge NUMBER [--dry-run] [--body-file PATH]',
    );
  }
  const body =
    values['body-file'] !== undefined
      ? readFileSync(values['body-file'], 'utf8').replace(/\r\n/gu, '\n')
      : '';
  assertMessageBody(body);

  const before = readPullRequest(pr, github);
  // No --required: optional smoke and other reported checks must also finish.
  github(['pr', 'checks', pr]);
  const current = readPullRequest(pr, github);
  if (current.head !== before.head) {
    throw new Error(
      'PR head changed during checks; rerun against the new head.',
    );
  }

  // Explicit subject/body prevent later title edits or repository defaults from
  // changing the message we just validated. GitHub enforces required checks too.
  const subject = `${current.title} (#${pr})`;
  assertMessageTitle(current.title);
  assertMessageTitle(subject);
  assertMessageBody(body);
  if (values['dry-run']) return `Dry run: squash ${current.head} as ${subject}`;

  return github(
    [
      'pr',
      'merge',
      pr,
      '--squash',
      '--match-head-commit',
      current.head,
      '--subject',
      subject,
      '--body-file',
      '-',
    ],
    body,
  );
}
