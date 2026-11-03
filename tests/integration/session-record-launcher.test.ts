import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { promisify } from 'node:util';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { isRecord } from '../../src/config/values.js';
import { isolatedEnv } from '../e2e/dsh/profile.js';

const execute = promisify(execFile);
const records = new URL('../../src/records.ts', import.meta.url).href;
let root: string;
let main: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-record-launcher-'));
  main = join(root, 'node_modules/@deepseek-ai/dsh/lib/bin.mjs');
  const sdk = join(root, 'node_modules/@deepseek-ai/dsh-session');
  await mkdir(dirname(main), { recursive: true });
  await mkdir(sdk, { recursive: true });
  await writeFile(
    join(sdk, 'package.json'),
    JSON.stringify({
      name: '@deepseek-ai/dsh-session',
      type: 'module',
      exports: './index.mjs',
    }),
  );
  // This stand-in proves package lookup and public-writer use only. The real
  // installed-runtime admission/sandbox cases provide the SDK behavior proof.
  await writeFile(
    join(sdk, 'index.mjs'),
    `
    export function appendPluginRecord(session, type, data) {
      session.events.push({type, data, ignorable: true});
      return session.events.length;
    }
  `,
  );
  await writeFile(main, script());
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function script(argvOverride?: string): string {
  return `
    import { loadSessionRecordApi, appendRecord, sessionRecordError } from ${JSON.stringify(records)};
    ${argvOverride === undefined ? '' : `process.argv[1] = ${JSON.stringify(argvOverride)};`}
    const [api, concurrent] = await Promise.all([loadSessionRecordApi(), loadSessionRecordApi()]);
    const cached = await loadSessionRecordApi();
    const session = {events: [], unsafe: 0, append() { this.unsafe++; }};
    const state = appendRecord(session, 'plugin:arbiter/probe', {callId: 'same-call'});
    console.log(JSON.stringify({available: api !== null, cached: api === concurrent && api === cached,
      state, events: session.events, unsafe: session.unsafe, error: sessionRecordError()}));
  `;
}

async function run(entry: string): Promise<unknown> {
  const result = await execute(process.execPath, [entry], {
    cwd: root,
    env: isolatedEnv(join(root, 'isolated-home')),
  });
  const value: unknown = JSON.parse(result.stdout);
  return value;
}

it.each(['direct', 'relative', 'absolute', 'chain'])(
  'resolves and caches the public writer through a %s CLI entry',
  async (kind) => {
    let entry = main;
    if (kind !== 'direct') {
      entry = join(root, 'node_modules/.bin/dsh');
      await mkdir(dirname(entry), { recursive: true });
      let target = kind === 'absolute' ? main : relative(dirname(entry), main);
      if (kind === 'chain') {
        const middle = join(root, 'middle');
        await symlink(main, middle);
        target = middle;
      }
      await symlink(target, entry);
    }
    expect(await run(entry)).toEqual({
      available: true,
      cached: true,
      state: 'written',
      unsafe: 0,
      error: null,
      events: [
        {
          type: 'plugin:arbiter/probe',
          data: { callId: 'same-call' },
          ignorable: true,
        },
      ],
    });
  },
);

it.each(['unrecognized', 'missing'])(
  'keeps a diagnostic and never calls session.append for a %s host entry',
  async (kind) => {
    const entry = join(root, 'unrecognized.mjs');
    await writeFile(
      entry,
      script(kind === 'missing' ? join(root, 'absent-link') : undefined),
    );
    const value = await run(entry);
    expect(value).toMatchObject({
      available: false,
      cached: true,
      unsafe: 0,
      events: [],
    });
    if (!isRecord(value))
      throw new Error('resolver subprocess returned no record');
    expect(value['error']).toEqual(
      expect.stringContaining('@deepseek-ai/dsh-session'),
    );
    expect(value['state']).toEqual(expect.stringMatching(/^failed:/u));
  },
);
