/**
 * Recovery-copy compatibility for converted legacy rules.
 *
 * The effective configuration always holds canonical rules, even when the profile
 * document used the legacy format. Two paths have to read that representation
 * back without treating it as a legacy document:
 *
 *   1. the UI saves a draft built from the effective configuration, so a user who
 *      changes an unrelated setting on a legacy document must still be able to
 *      save;
 *   2. the recovery copy (`last-good`) is written from the effective
 *      configuration and re-parsed on a cold start.
 *
 * Both are exercised here against the real host and a real SQLite audit store.
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

const LEGACY_RULE = {
  id: 'keep-me',
  match: { node: 'command', kind: 'regex', pattern: '^gh pr view(?: .*)?$' },
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
  readonly restart: (config: unknown) => Harness;
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
  const build = (host: HostEnvironment): Harness => ({
    home,
    host,
    documentPath,
    restart: (next: unknown) => build(initializeHost(parts.ctx, next)),
  });
  return build(initializeHost(parts.ctx, config));
}

describe('converted legacy rules survive a round trip', () => {
  test('a legacy document loads as canonical rules and stays savable', async () => {
    const harness = await createHarness({ rules: [LEGACY_RULE] });
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

  test('the recovery copy of a converted document is restorable', async () => {
    const harness = await createHarness({ rules: [LEGACY_RULE] });
    const lastGood = join(harness.home, 'arbiter', 'last-good');
    const entries = await readdir(lastGood);
    expect(entries).toHaveLength(1);
    const record: unknown = JSON.parse(
      await readFile(join(lastGood, entries[0] ?? ''), 'utf8'),
    );
    // The copy declares the canonical format this build writes while remembering
    // that the running configuration was implicit.
    expect(record).toMatchObject({
      format: 'arbiter-config-v3',
      sourceFormatExplicit: false,
      sourceFormat: null,
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
    { name: 'implicit', document: { enabled: false }, explicit: false },
    {
      name: 'explicit v1',
      document: { format: 'arbiter-config-v1', enabled: false },
      explicit: true,
    },
    {
      name: 'explicit v2',
      document: { format: 'arbiter-config-v2', enabled: false },
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

      // Cold start: no runtime for this profile, so only the copy can answer.
      vi.resetModules();
      const fresh = await import('../../src/host/runtime.js');
      const parts = createStubContext({
        profileContext: {
          home: harness.home,
          dir: join(harness.home, 'profiles', 'recovery'),
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
      const host = fresh.initializeHost(parts.ctx, {
        format: 'arbiter-config-v9',
      });
      const after = host.runtime.config;
      // The declared format is part of the content, so recovery restores the same
      // identity rather than a canonical-looking rewrite of it.
      expect(after.format).toBe(formatBefore);
      expect(configHash(after)).toBe(hashBefore);
      expect(host.runtime.configFormatExplicit).toBe(explicit);
      expect(after.enabled).toBe(false);
    },
  );

  test('a cold start recovers converted rules rather than falling back', async () => {
    const harness = await createHarness({ rules: [LEGACY_RULE] });
    // A cold start has no runtime for this profile yet. Resetting the module
    // registry gives a fresh runtime map while keeping the same temp home, so the
    // host must fall back to the recovery copy instead of the in-memory config.
    vi.resetModules();
    const fresh = await import('../../src/host/runtime.js');
    const parts = createStubContext({
      profileContext: {
        home: harness.home,
        dir: join(harness.home, 'profiles', 'recovery'),
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
    // The profile document is unreadable, so the host must use the copy.
    const host = fresh.initializeHost(parts.ctx, {
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
