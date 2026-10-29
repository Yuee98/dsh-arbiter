/**
 * Recovery-copy identity and continuity for the current configuration format.
 *
 * The effective configuration is always canonical rules. Two paths have to read
 * that representation back:
 *
 *   1. the UI saves a draft built from the effective configuration, so a change to
 *      an unrelated setting must not invalidate the rules;
 *   2. the recovery copy (`last-good`) is written from the effective configuration
 *      and re-parsed on a cold start.
 *
 * Both are exercised here against the real host and a real SQLite audit store. A
 * copy that declares a retired format is refused rather than read as this one,
 * because the reading it fell back to could be the wider connective.
 */

import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import { configHash, parseConfig } from '../../src/config.js';
import { cloneDraft } from '../../src/client/view-helpers.js';
import { ConfigurationAccess } from '../../src/host/configuration.js';
import { initializeHost } from '../../src/host/runtime.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';
import type { HostEnvironment } from '../../src/host/types.js';

const RULE = {
  id: 'keep-me',
  conditions: [
    { target: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
  ],
  verdict: 'allow',
};

let root: string;
const disposers: (() => unknown)[] = [];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-recovery-'));
});

afterEach(async () => {
  for (const dispose of disposers.splice(0)) dispose();
  await rm(root, { recursive: true, force: true });
});

interface Harness {
  readonly home: string;
  readonly host: HostEnvironment;
  readonly documentPath: string;
}

async function createHarness(config: unknown): Promise<Harness> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'recovery');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(documentPath, `${JSON.stringify(config)}\n`, 'utf8');
  const parts = createStubContext({
    profileContext: { home, dir: profileDir, name: 'recovery' },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    approval: { request: () => Promise.resolve('unavailable') },
    permissionPresets: { registerAuto: () => () => undefined },
    configEditor: stubEditor({
      documentPath,
      config: () => config,
      onEdit: () => undefined,
    }),
    connection: { fetch: { register: () => () => undefined } },
  });
  disposers.push(() => {
    for (const dispose of parts.disposers) dispose();
  });
  return { home, host: initializeHost(parts.ctx, config), documentPath };
}

describe('a saved document survives the round trip', () => {
  test('a document loads as canonical rules and stays savable', async () => {
    const harness = await createHarness({ rules: [RULE] });
    expect(harness.host.runtime.config.rules).toHaveLength(1);
    expect(harness.host.runtime.config.rules[0]?.conditions).toEqual([
      { target: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
    ]);

    // The UI builds its draft from the effective configuration.
    const draft = cloneDraft(harness.host.runtime.config);
    // A change to an unrelated setting must not invalidate the rules.
    const parsed = parseConfig({ ...draft, enabled: false });
    expect(parsed.errors).toEqual([]);
    expect(parsed.config.rules).toHaveLength(1);
    expect(parsed.config.rules[0]?.id).toBe('keep-me');
    expect(parsed.config.enabled).toBe(false);

    // The real save path accepts the normalized document.
    const access = new ConfigurationAccess(harness.host);
    const response = await access.save(
      new Request('http://localhost/api/arbiter/config/save', {
        method: 'POST',
        body: JSON.stringify({
          revision: access.fileRevision(),
          config: { ...draft, enabled: false },
        }),
      }),
    );
    expect(response.status).toBe(200);
  });

  test('the recovery copy of a document is restorable', async () => {
    const harness = await createHarness({ rules: [RULE] });
    const lastGood = join(harness.home, 'arbiter', 'last-good');
    const entries = await readdir(lastGood);
    expect(entries).toHaveLength(1);
    const record: unknown = JSON.parse(
      await readFile(join(lastGood, entries[0] ?? ''), 'utf8'),
    );
    // The copy declares the format this build writes while remembering that the
    // running configuration declared nothing.
    expect(record).toMatchObject({
      format: 'arbiter-config-v3',
      sourceFormatExplicit: false,
    });
    const stored: unknown =
      record !== null && typeof record === 'object'
        ? Reflect.get(record, 'config')
        : undefined;
    const reparsed = parseConfig({
      ...(stored !== null && typeof stored === 'object' ? stored : {}),
      format: 'arbiter-config-v3',
    });
    expect(reparsed.errors).toEqual([]);
    expect(reparsed.config.rules).toHaveLength(1);
    expect(reparsed.config.rules[0]?.conditions).toEqual([
      { target: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
    ]);
  });

  test.each([
    { name: 'undeclared', document: { enabled: false }, explicit: false },
    {
      name: 'declared',
      document: { format: 'arbiter-config-v3', enabled: false },
      explicit: true,
    },
  ])(
    'recovery preserves the $name format identity',
    async ({ document, explicit }) => {
      const harness = await createHarness(document);
      const before = harness.host.runtime.config;
      const hashBefore = configHash(before);
      const formatBefore = before.format;
      expect(harness.host.runtime.configFormatExplicit).toBe(explicit);

      const host = await coldStart(harness.home);
      const after = host.runtime.config;
      // The declaration is part of the content, so recovery restores the same
      // identity rather than forcing one.
      expect(after.format).toBe(formatBefore);
      expect(configHash(after)).toBe(hashBefore);
      expect(host.runtime.configFormatExplicit).toBe(explicit);
      expect(after.enabled).toBe(false);
    },
  );

  test('a cold start recovers the rules rather than falling back', async () => {
    const harness = await createHarness({ rules: [RULE] });
    // The profile document is unreadable, so the host must use the copy.
    const host = await coldStart(harness.home, {
      rules: [
        {
          id: 'broken',
          conditions: [{ target: 'command', kind: 'regex', pattern: '(' }],
          verdict: 'deny',
        },
      ],
    });
    expect(host.runtime.invalidConfigError).not.toBeNull();
    expect(host.runtime.config.rules).toHaveLength(1);
    expect(host.runtime.config.rules[0]?.id).toBe('keep-me');
    expect(host.runtime.config.rules[0]?.conditions).toEqual([
      { target: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
    ]);
  });
});

/**
 * A copy written by a build that still knew the retired formats.
 *
 * That build wrote a current-format wrapper around already-normalized rules while
 * also recording the retired declaration the *source document* had. The wrapper is
 * readable here, so its rules and connective come back. What must not come back is
 * the retired declaration: the copy's `sourceFormat` is ignored rather than
 * replayed, because replaying it would describe a running configuration as one this
 * build refuses to load.
 */
describe('a copy left by a build with the retired formats', () => {
  const RULE = {
    id: 'kept-normalized',
    conditions: [{ target: 'command', kind: 'exact', pattern: 'echo hi' }],
    verdict: 'deny',
  };

  test('its rules recover but its retired declaration does not come back', async () => {
    const harness = await createHarness({
      format: 'arbiter-config-v3',
      rules: [RULE],
    });
    const directory = join(harness.home, 'arbiter', 'last-good');
    const [entry] = await readdir(directory);
    if (entry === undefined) throw new Error('no recovery copy was written');
    const path = join(directory, entry);
    const record: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (record === null || typeof record !== 'object')
      throw new TypeError('the copy must be an object');
    // The shape the previous build left on disk: a current-format wrapper, a
    // canonical payload, and a retired `sourceFormat` recording what the profile
    // document had declared.
    Reflect.set(record, 'sourceFormatExplicit', true);
    Reflect.set(record, 'sourceFormat', 'arbiter-config-v2');
    await writeFile(path, JSON.stringify(record), 'utf8');

    const host = await coldStart(harness.home);
    const recovered = host.runtime.config;
    expect(recovered.rules[0]?.id).toBe('kept-normalized');
    // The copy is read as what it is — a current-format payload — rather than as
    // the retired document it once described.
    expect(recovered.format).toBe('arbiter-config-v3');
    expect(host.runtime.configFormat).toBe('arbiter-config-v3');
    // The load error describes this build's *document* (the invalid declaration in
    // the profile), not the retired declaration recorded by the old copy.
    expect(host.runtime.invalidConfigError).toContain('arbiter-config-v9');
    expect(host.runtime.invalidConfigError).not.toContain('arbiter-config-v2');
    expect(JSON.stringify(recovered)).not.toContain('arbiter-config-v2');
  });
});

/**
 * The rule connective across the recovery boundary.
 *
 * Recovery is where a wider reading could come back silently, so a broken copy is
 * refused rather than reinterpreted, and a copy that is not in this build's format
 * is not a fallback candidate at all.
 */
describe('recovery around the rule connective', () => {
  const CONJUNCTION = {
    id: 'push-to-dev',
    combine: 'all',
    conditions: [
      { target: 'command', kind: 'exact', pattern: 'git push' },
      {
        target: 'argument',
        path: '$.environment',
        kind: 'exact',
        pattern: 'dev',
      },
    ],
    verdict: 'allow',
  };

  test('a copy recovers with its connective intact after a cold start', async () => {
    const harness = await createHarness({
      format: 'arbiter-config-v3',
      rules: [CONJUNCTION],
    });
    const host = await coldStart(harness.home);
    const recovered = host.runtime.config.rules[0];
    expect(recovered?.combine).toBe('all');
    expect(recovered?.id).toBe('push-to-dev');
  });

  test('a copy declaring a retired format is refused, not read as this one', async () => {
    const harness = await createHarness({
      format: 'arbiter-config-v3',
      rules: [CONJUNCTION],
    });
    const directory = join(harness.home, 'arbiter', 'last-good');
    const [entry] = await readdir(directory);
    if (entry === undefined) throw new Error('no recovery copy was written');
    const path = join(directory, entry);
    const record: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (record === null || typeof record !== 'object')
      throw new TypeError('the copy must be an object');
    // Rewrite the wrapper the way a copy produced by a build that still knew the
    // retired format would look: a declaration this build no longer reads.
    Reflect.set(record, 'format', 'arbiter-config-v2');
    await writeFile(path, JSON.stringify(record), 'utf8');

    const host = await coldStart(harness.home);
    // The copy cannot be read at all, so nothing is recovered from it. Falling back
    // to it under another reading could resurrect "either condition".
    expect(host.runtime.config.rules).toEqual([]);
  });

  test('a copy whose connective is broken is refused, not guessed', async () => {
    const harness = await createHarness({
      format: 'arbiter-config-v3',
      rules: [CONJUNCTION],
    });
    const directory = join(harness.home, 'arbiter', 'last-good');
    const [entry] = await readdir(directory);
    if (entry === undefined) throw new Error('no recovery copy was written');
    const path = join(directory, entry);
    const record: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (record === null || typeof record !== 'object')
      throw new TypeError('the copy must be an object');
    const stored: unknown = Reflect.get(record, 'config');
    if (stored === null || typeof stored !== 'object')
      throw new TypeError('the copy must carry a config');
    const rules: unknown = Reflect.get(stored, 'rules');
    if (!Array.isArray(rules) || rules.length === 0)
      throw new TypeError('the copy must carry rules');
    const rule: unknown = rules[0];
    if (rule === null || typeof rule !== 'object')
      throw new TypeError('the rule must be an object');
    // Break the connective the way a corrupted file would: the field is gone
    // while two conditions remain.
    Reflect.deleteProperty(rule, 'combine');
    await writeFile(path, JSON.stringify(record), 'utf8');

    const host = await coldStart(harness.home);
    // The copy cannot be trusted, so it is not used. Guessing "any" would
    // resurrect the rule as either condition, the wider direction.
    expect(host.runtime.config.rules).toEqual([]);
  });
});

/**
 * A host that has never seen this profile, so only the copy on disk can answer.
 *
 * Resetting the module registry gives a fresh runtime map while keeping the same
 * temporary home; without it the in-memory configuration of the previous host
 * would mask whatever the copy says. The document is invalid by default, so the
 * copy is the only candidate.
 */
async function coldStart(
  home: string,
  document: unknown = { format: 'arbiter-config-v9' },
): Promise<HostEnvironment> {
  vi.resetModules();
  const fresh = await import('../../src/host/runtime.js');
  const parts = createStubContext({
    profileContext: {
      home,
      dir: join(home, 'profiles', 'recovery'),
      name: 'recovery',
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    approval: { request: () => Promise.resolve('unavailable') },
    permissionPresets: { registerAuto: () => () => undefined },
    connection: { fetch: { register: () => () => undefined } },
  });
  disposers.push(() => {
    for (const dispose of parts.disposers) dispose();
  });
  return fresh.initializeHost(parts.ctx, document);
}
