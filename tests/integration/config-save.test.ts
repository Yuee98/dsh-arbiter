import { writeFileSync } from 'node:fs';
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

import { ConfigurationAccess } from '../../src/host/configuration.js';
import { initializeHost } from '../../src/host/runtime.js';
import { statePayload } from '../../src/host/state.js';
import type {
  ConfigEditorLike,
  HostEnvironment,
} from '../../src/host/types.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

interface Harness {
  readonly home: string;
  readonly documentPath: string;
  readonly host: HostEnvironment;
  readonly state: () => Record<string, unknown>;
  readonly history: () => readonly { readonly entry: string }[];
  readonly dispose: () => void;
  readonly editCalls: readonly unknown[];
  readonly services: {
    readonly sessions: ReturnType<typeof vi.fn>;
    readonly approvalRequest: ReturnType<typeof vi.fn>;
    readonly registerAuto: ReturnType<typeof vi.fn>;
  };
  readonly reread: (config: unknown) => Harness;
}

/** The state payload is JSON-shaped; this reader keeps it assertion-free. */
function stubbedState(host: HostEnvironment): Record<string, unknown> {
  const payload: unknown = statePayload(host, new ConfigurationAccess(host));
  if (payload === null || typeof payload !== 'object')
    throw new TypeError('state payload must be an object');
  return { ...payload };
}

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'arbiter-config-'));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

interface HarnessOptions {
  readonly config?: unknown;
  readonly blockAudit?: boolean;
  readonly editFailure?: string;
  readonly onEdit?: (config: unknown) => void;
}

/** A profile-shaped patch file plus a real SQLite audit store. */
async function createHarness(
  options: HarnessOptions = {},
  previous?: Harness,
): Promise<Harness> {
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'arbiter-config-test');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  if (options.blockAudit === true)
    await writeFile(join(home, 'arbiter'), 'not a directory');
  await writeFile(
    documentPath,
    options.config === undefined
      ? '[]\n'
      : `${JSON.stringify(options.config)}\n`,
    'utf8',
  );

  const editCalls: unknown[] = [];
  let current: unknown = options.config ?? {};
  const editor: ConfigEditorLike = stubEditor({
    documentPath,
    config: () => current,
    onEdit: (next) => {
      if (options.editFailure !== undefined) return;
      editCalls.push(next);
      current = next;
      // The real editor persists the row before reconciling the Loader.
      writeFileSync(documentPath, `${JSON.stringify(next)}\n`, 'utf8');
      options.onEdit?.(next);
    },
    ...(options.editFailure === undefined
      ? {}
      : { failure: options.editFailure }),
  });
  const services = {
    sessions: vi.fn(),
    approvalRequest: vi.fn(),
    registerAuto: vi.fn(),
  };
  const parts = createStubContext({
    profileContext: { home, dir: profileDir, name: 'arbiter-config-test' },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    approval: { request: services.approvalRequest },
    permissionPresets: { registerAuto: services.registerAuto },
    configEditor: editor,
    connection: { fetch: { register: () => () => undefined } },
  });

  const build = (host: HostEnvironment): Harness => ({
    home,
    documentPath,
    host,
    state: () => stubbedState(host),
    history: () => host.audit?.configHistory(50) ?? [],
    dispose: () => {
      for (const dispose of parts.disposers) dispose();
      previous?.dispose();
    },
    editCalls,
    services,
    reread: (config: unknown) => build(initializeHost(parts.ctx, config)),
  });
  return build(initializeHost(parts.ctx, options.config));
}

async function save(
  harness: Harness,
  config: unknown,
): Promise<{
  readonly status: number;
  readonly body: Record<string, unknown>;
}> {
  const access = new ConfigurationAccess(harness.host);
  const response = await access.save(
    new Request('http://localhost/api/arbiter/config/save', {
      method: 'POST',
      body: JSON.stringify({ revision: access.fileRevision(), config }),
    }),
  );
  const payload: unknown = await response.json();
  if (payload === null || typeof payload !== 'object')
    throw new TypeError('save response must be an object');
  return { status: response.status, body: { ...payload } };
}

describe('first install and reload activation', () => {
  test('a profile without a document activates the confirmed defaults once', async () => {
    const harness = await createHarness();
    try {
      const state = harness.state();
      expect(state['config']).toMatchObject({
        enabled: true,
        modes: { main: 'ask', subagent: 'no-ask' },
        rules: [],
        reviewer: { type: 'chat', chat: { provider: 'session' } },
        audit: { retentionDays: 30, retentionBytes: 1024 ** 3 },
      });
      expect(state['configFormat']).toBe('arbiter-config-v3');
      expect(state['configFormatExplicit']).toBe(false);
      expect(state['invalidConfigError']).toBeNull();
      expect(state['configSnapshotId']).toMatch(/^cfg-/);
      expect(harness.history()).toHaveLength(1);
      expect(harness.history()[0]?.entry).toBe('startup');
    } finally {
      harness.dispose();
    }
  });

  test('an existing document is not overwritten by the first-install defaults', async () => {
    const harness = await createHarness({
      config: { enabled: false, modes: { main: 'no-ask' } },
    });
    try {
      expect(harness.state()['config']).toMatchObject({
        enabled: false,
        modes: { main: 'no-ask', subagent: 'no-ask' },
      });
      expect(harness.history()[0]?.entry).toBe('startup');
    } finally {
      harness.dispose();
    }
  });

  test('reloading identical content reuses the snapshot and records no new activation', async () => {
    const first = await createHarness({ config: { enabled: false } });
    const before = first.state();
    const reloaded = first.reread({ enabled: false });
    try {
      expect(reloaded.state()['configSnapshotId']).toBe(
        before['configSnapshotId'],
      );
      expect(reloaded.state()['effectiveRevision']).toBe(
        before['effectiveRevision'],
      );
      expect(reloaded.history()).toHaveLength(1);
    } finally {
      reloaded.dispose();
    }
  });

  test('an external replacement applies as a file activation with a new revision', async () => {
    const first = await createHarness({ config: { enabled: false } });
    const before = first.state();
    const reloaded = first.reread({
      enabled: true,
      modes: { main: 'no-ask' },
    });
    try {
      expect(reloaded.state()['effectiveRevision']).not.toBe(
        before['effectiveRevision'],
      );
      expect(reloaded.state()['config']).toMatchObject({
        enabled: true,
        modes: { main: 'no-ask' },
      });
      expect(reloaded.history()[0]?.entry).toBe('file');
      expect(reloaded.history()).toHaveLength(2);
    } finally {
      reloaded.dispose();
    }
  });

  test('restoring earlier content reuses its snapshot and records a new activation', async () => {
    const first = await createHarness({ config: { enabled: false } });
    const original = first.state();
    const changed = first.reread({ enabled: true });
    expect(changed.state()['configSnapshotId']).not.toBe(
      original['configSnapshotId'],
    );
    const restored = changed.reread({ enabled: false });
    try {
      expect(restored.state()['configSnapshotId']).toBe(
        original['configSnapshotId'],
      );
      expect(restored.history()).toHaveLength(3);
      expect(
        restored.history().filter((row) => row.entry === 'file'),
      ).toHaveLength(2);
    } finally {
      restored.dispose();
    }
  });

  test('an invalid file keeps the effective configuration and reports the load error', async () => {
    const first = await createHarness({ config: { enabled: false } });
    const before = first.state();
    const reloaded = first.reread({ format: 'arbiter-config-v9' });
    try {
      const after = reloaded.state();
      expect(after['config']).toEqual(before['config']);
      expect(after['effectiveRevision']).toBe(before['effectiveRevision']);
      expect(after['configSnapshotId']).toBe(before['configSnapshotId']);
      expect(after['invalidConfigError']).toContain('format');
      expect(after['loadErrors']).toHaveLength(1);
      expect(reloaded.history()).toHaveLength(1);
    } finally {
      reloaded.dispose();
    }
  });
});

describe('shared save path', () => {
  test('a UI save writes the file, applies the content and reports saved plus effective', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const before = harness.state();
      const result = await save(harness, {
        enabled: true,
        modes: { main: 'no-ask' },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        ok: true,
        saved: true,
        effective: true,
        changed: true,
        activationRecorded: true,
        auditError: null,
      });
      expect(result.body['effectiveRevision']).not.toBe(
        before['effectiveRevision'],
      );
      expect(
        JSON.parse(await readFile(harness.documentPath, 'utf8')),
      ).toMatchObject({ enabled: true });
      expect(harness.host.runtime.config.modes.main).toBe('no-ask');
      expect(harness.history()[0]?.entry).toBe('ui');
      expect(harness.services.sessions).not.toHaveBeenCalled();
      expect(harness.services.approvalRequest).not.toHaveBeenCalled();
      expect(harness.services.registerAuto).not.toHaveBeenCalled();
    } finally {
      harness.dispose();
    }
  });

  test('saving identical content writes the file but records no new activation', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const result = await save(harness, { enabled: false });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        saved: true,
        changed: false,
        effective: true,
        activationRecorded: false,
      });
      expect(harness.history()).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test('a concurrent file revision rejects the save and keeps both draft and effective configuration', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const access = new ConfigurationAccess(harness.host);
      const stale = access.fileRevision();
      const before = harness.state();
      await writeFile(harness.documentPath, 'external change\n', 'utf8');
      const response = await access.save(
        new Request('http://localhost/api/arbiter/config/save', {
          method: 'POST',
          body: JSON.stringify({ revision: stale, config: { enabled: true } }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'config-conflict',
        fileRevision: access.fileRevision(),
      });
      expect(harness.editCalls).toEqual([]);
      expect(harness.host.runtime.config.enabled).toBe(false);
      expect(harness.state()['effectiveRevision']).toBe(
        before['effectiveRevision'],
      );
      expect(harness.history()).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test('a validation error rejects the save before the editor is touched', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const result = await save(harness, {
        format: 'arbiter-config-unknown',
        rules: [{ id: 'broken' }],
      });
      expect(result.status).toBe(422);
      expect(result.body['code']).toBe('config-invalid');
      expect(result.body['errors']).toEqual(
        expect.arrayContaining([expect.objectContaining({ path: 'format' })]),
      );
      expect(harness.editCalls).toEqual([]);
      expect(harness.host.runtime.config.enabled).toBe(false);
    } finally {
      harness.dispose();
    }
  });

  test('an apply failure reports rejected and never claims the candidate is effective', async () => {
    const harness = await createHarness({
      config: { enabled: false },
      editFailure: 'loader rejected the row',
    });
    try {
      const before = harness.state();
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(422);
      expect(result.body).toMatchObject({
        code: 'config-rejected',
        message: 'loader rejected the row',
      });
      expect(harness.host.runtime.config.enabled).toBe(false);
      expect(harness.state()['effectiveRevision']).toBe(
        before['effectiveRevision'],
      );
      expect(harness.state()['configSnapshotId']).toBe(
        before['configSnapshotId'],
      );
      expect(harness.history()).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });

  test('a UI save still takes effect when audit storage is unavailable', async () => {
    const harness = await createHarness({
      config: { enabled: false },
      blockAudit: true,
    });
    try {
      const result = await save(harness, {
        enabled: true,
        modes: { main: 'no-ask' },
      });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        saved: true,
        effective: true,
        changed: true,
        activationRecorded: false,
      });
      expect(typeof result.body['auditError']).toBe('string');
      expect(harness.host.runtime.config).toMatchObject({
        enabled: true,
        modes: { main: 'no-ask' },
      });
      expect(harness.state()['effectiveRevision']).toMatch(/^[0-9a-f]{8}$/);
      expect(harness.history()).toEqual([]);
    } finally {
      harness.dispose();
    }
  });

  test('a reload triggered by the save is attributed to the UI once', async () => {
    let reloaded: Harness | undefined;
    const harness = await createHarness({
      config: { enabled: false },
      onEdit: (config) => {
        // The real editor reconciles the Loader, which re-initializes the
        // plugin with the freshly written row before `edit()` resolves.
        reloaded = harness.reread(config);
      },
    });
    try {
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(200);
      expect(reloaded).toBeDefined();
      const history = harness.history();
      expect(history).toHaveLength(2);
      expect(history[0]?.entry).toBe('ui');
      expect(harness.state()['configSnapshotId']).toBe(
        harness.host.runtime.configSnapshotId,
      );
    } finally {
      reloaded?.dispose();
      harness.dispose();
    }
  });
});

describe('write-lock revision check', () => {
  test('a revision that changes between parsing and the serialized write is rejected', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const access = new ConfigurationAccess(harness.host);
      const stale = access.fileRevision();
      const before = harness.state();
      // A competing writer lands after the request was validated but before the
      // editor's `change` callback runs under its own lock.
      const editor = harness.host.services.configEditor;
      if (editor === undefined) throw new Error('missing editor');
      const originalEdit = editor.edit.bind(editor);
      editor.edit = (entry, change) => {
        writeFileSync(harness.documentPath, 'competing write\n', 'utf8');
        return originalEdit(entry, change);
      };
      const response = await access.save(
        new Request('http://localhost/api/arbiter/config/save', {
          method: 'POST',
          body: JSON.stringify({ revision: stale, config: { enabled: true } }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: 'config-conflict',
        message: 'the profile patch changed after this draft was read',
      });
      expect(harness.editCalls).toEqual([]);
      expect(harness.host.runtime.config.enabled).toBe(false);
      expect(harness.state()['effectiveRevision']).toBe(
        before['effectiveRevision'],
      );
    } finally {
      harness.dispose();
    }
  });

  test('a body without an object config is a bad request, not a default save', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const access = new ConfigurationAccess(harness.host);
      const revision = access.fileRevision();
      for (const body of [
        { revision },
        { revision, config: null },
        { revision, config: 'modules: []' },
      ]) {
        const response = await access.save(
          new Request('http://localhost/api/arbiter/config/save', {
            method: 'POST',
            body: JSON.stringify(body),
          }),
        );
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: 'bad-request',
          errors: [expect.objectContaining({ code: 'config.not-object' })],
        });
      }
      expect(harness.editCalls).toEqual([]);
      expect(harness.host.runtime.config.enabled).toBe(false);
      expect(harness.history()).toHaveLength(1);
    } finally {
      harness.dispose();
    }
  });
});

describe('recovery data follows the committed configuration', () => {
  test('a rejected application leaves the previous last-good document intact', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      // A first successful save establishes the continuity copy for A.
      expect((await save(harness, { enabled: true })).status).toBe(200);
      const lastGood = join(harness.home, 'arbiter', 'last-good');
      const entries = await readdir(lastGood);
      expect(entries).toHaveLength(1);
      const appliedText = await readFile(
        join(lastGood, entries[0] ?? ''),
        'utf8',
      );
      // The copy keeps the original content plus the format identity it ran
      // with, so a cold start replays the same revision.
      expect(JSON.parse(appliedText) as unknown).toMatchObject({
        config: { enabled: true },
        sourceFormatExplicit: false,
      });

      // B is validated but never applied: the copy must stay at A.
      const editor = harness.host.services.configEditor;
      if (editor === undefined) throw new Error('missing editor');
      editor.edit = () => Promise.reject(new Error('loader rejected the row'));
      expect((await save(harness, { enabled: false })).status).toBe(422);
      expect(harness.host.runtime.config.enabled).toBe(true);
      expect(
        JSON.parse(await readFile(join(lastGood, entries[0] ?? ''), 'utf8')),
      ).toMatchObject({ config: { enabled: true } });
    } finally {
      harness.dispose();
    }
  });
});

describe('audit failure ordering', () => {
  test('a snapshot write failure never reports the previous snapshot as current', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const before = harness.state();
      expect(before['configSnapshotId']).toMatch(/^cfg-/);
      // Fail the next snapshot insert while keeping the store readable.
      const audit = harness.host.audit;
      if (audit === null) throw new Error('missing audit');
      const original = audit.saveConfigSnapshot.bind(audit);
      // The store contains write failures, so a failed persist is reported as
      // "not persisted" rather than thrown into configuration apply.
      audit.saveConfigSnapshot = () => null;
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        saved: true,
        effective: true,
        changed: true,
        activationRecorded: false,
      });
      expect(harness.host.runtime.config.enabled).toBe(true);
      const after = harness.state();
      // The old id belongs to different content: it must not be reused.
      expect(after['configSnapshotId']).toBe('cfg-unavailable');
      expect(after['configHistoryComplete']).toBe(false);
      expect(typeof after['effectiveRevision']).toBe('string');
      audit.saveConfigSnapshot = original;
    } finally {
      harness.dispose();
    }
  });

  test('an activation insert failure is not counted as recorded', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const before = harness.state();
      const audit = harness.host.audit;
      if (audit === null) throw new Error('missing audit');
      audit.recordActivation = () => false;
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        effective: true,
        activationRecorded: false,
      });
      // The snapshot itself was persisted, so the effective identity is real.
      expect(harness.state()['configSnapshotId']).not.toBe(
        before['configSnapshotId'],
      );
      expect(harness.state()['configHistoryComplete']).toBe(false);
      expect(harness.host.runtime.configActivations).toBe(
        before['configHistory'] === undefined ? 0 : 1,
      );
    } finally {
      harness.dispose();
    }
  });

  test('reopening the audit store does not claim a lost activation was written', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const audit = harness.host.audit;
      if (audit === null) throw new Error('missing audit');
      audit.recordActivation = () => false;
      await save(harness, { enabled: true });
      expect(harness.state()['configHistoryComplete']).toBe(false);
      // A subsequent healthy write does not retroactively restore the row.
      await save(harness, { enabled: false });
      expect(harness.state()['configHistoryComplete']).toBe(false);
    } finally {
      harness.dispose();
    }
  });
});

describe('cold restart recovery', () => {
  test('the first accepted document is recoverable after a real cold start', async () => {
    // Phase 1: a first process writes the continuity copy for a custom document.
    const first = await createHarness({ config: { enabled: false } });
    const home = first.home;
    const lastGood = join(home, 'arbiter', 'last-good');
    const firstState = first.state();
    const snapshotBefore = firstState['configSnapshotId'];
    try {
      const entries = await readdir(lastGood);
      expect(entries).toHaveLength(1);
      expect(
        JSON.parse(await readFile(join(lastGood, entries[0] ?? ''), 'utf8')),
      ).toMatchObject({ config: { enabled: false } });
      expect(String(snapshotBefore)).toMatch(/^cfg-/);
    } finally {
      first.dispose();
    }

    // Phase 2: a genuinely new module instance, so the in-process runtime map is
    // empty and only the on-disk copy can supply the fallback.
    vi.resetModules();
    const freshRuntime = await import('../../src/host/runtime.js');
    const freshConfiguration = await import('../../src/host/configuration.js');
    const profileDir = join(home, 'profiles', 'arbiter-config-test');
    const documentPath = join(profileDir, 'cordis.patch.yml');
    await writeFile(
      documentPath,
      JSON.stringify({ format: 'arbiter-config-v9' }),
      'utf8',
    );
    const parts = createStubContext({
      profileContext: { home, dir: profileDir, name: 'arbiter-config-test' },
      sandboxPolicy: { defaultMode: 'workspace-write' },
      configEditor: stubEditor({
        documentPath,
        config: () => ({}),
        onEdit: () => undefined,
      }),
      connection: { fetch: { register: () => () => undefined } },
    });
    const cold = freshRuntime.initializeHost(parts.ctx, {
      format: 'arbiter-config-v9',
    });
    try {
      expect(cold.runtime.config).toMatchObject({
        enabled: false,
        modes: { main: 'ask', subagent: 'no-ask' },
      });
      expect(cold.runtime.invalidConfigError).toContain('format');
      // Identical content reuses the persisted snapshot, so a cold start never
      // creates a second snapshot for the same effective configuration.
      expect(cold.runtime.configSnapshotId).toBe(String(snapshotBefore));
      // The rejected document itself was never activated.
      const entries = cold.audit?.configHistory(10) ?? [];
      expect(entries[0]?.snapshotId).toBe(String(snapshotBefore));
      expect(freshConfiguration.ConfigurationAccess).toBeTypeOf('function');
    } finally {
      for (const dispose of parts.disposers) dispose();
    }
  });
});

describe('UI attribution correlation', () => {
  test('an unrelated external reload does not consume the pending UI save marker', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const editor = harness.host.services.configEditor;
      if (editor === undefined) throw new Error('missing editor');
      // While the UI save waits for the write lock, a different document is
      // applied by an external reload.
      editor.edit = () => {
        const external = harness.reread({
          enabled: true,
          modes: { main: 'no-ask' },
        });
        external.dispose();
        return Promise.reject(new Error('revision changed'));
      };
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(422);
      // The external change is attributed to the file, not to this save.
      expect(harness.history()[0]?.entry).toBe('file');
      expect(harness.host.runtime.config.modes.main).toBe('no-ask');
    } finally {
      harness.dispose();
    }
  });
});

describe('retention failure scope', () => {
  test('a retention error keeps the committed snapshot and activation reusable', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const audit = harness.host.audit;
      if (audit === null) throw new Error('missing audit');
      audit.runRetention = () => {
        throw new Error('retention failed');
      };
      const result = await save(harness, { enabled: true });
      expect(result.status).toBe(200);
      expect(result.body).toMatchObject({
        effective: true,
        changed: true,
        activationRecorded: true,
        // Cleanup failed, but history for this activation is complete.
        auditError: null,
      });
      const committed = harness.state()['configSnapshotId'];
      expect(committed).toMatch(/^cfg-/);
      expect(harness.state()['configHistoryComplete']).toBe(true);
      expect(harness.history()).toHaveLength(2);

      // Same content again: the persisted snapshot is reused, no extra row.
      const again = await save(harness, { enabled: true });
      expect(again.body).toMatchObject({
        changed: false,
        activationRecorded: false,
      });
      expect(harness.state()['configSnapshotId']).toBe(committed);
      expect(harness.history()).toHaveLength(2);
    } finally {
      harness.dispose();
    }
  });
});

describe('competing UI saves', () => {
  test('the rejected save does not relabel the accepted one as a file change', async () => {
    const harness = await createHarness({ config: { enabled: false } });
    try {
      const editor = harness.host.services.configEditor;
      if (editor === undefined) throw new Error('missing editor');
      const access = new ConfigurationAccess(harness.host);
      const revision = access.fileRevision();
      const request = (config: Record<string, unknown>): Request =>
        new Request('http://localhost/api/arbiter/config/save', {
          method: 'POST',
          body: JSON.stringify({ revision, config }),
        });

      const firstEdit = editor.edit.bind(editor);
      let nested: Promise<Response> | undefined;
      editor.edit = (entry, change) => {
        // A second save with different content lands while the first holds the
        // lock; it must be rejected by the revision check, not steal the marker.
        if (nested === undefined)
          nested = new ConfigurationAccess(harness.host).save(
            request({ enabled: true, modes: { main: 'no-ask' } }),
          );
        return firstEdit(entry, change);
      };
      const accepted = await access.save(request({ enabled: true }));
      expect(accepted.status).toBe(200);
      expect(nested).toBeDefined();
      expect(await nested?.then((response) => response.status)).toBe(409);
      // The accepted content's reload is attributed to the UI exactly once.
      expect(harness.history()[0]?.entry).toBe('ui');
      expect(harness.host.runtime.config.modes.main).toBe('ask');
    } finally {
      harness.dispose();
    }
  });
});
