import { readFile, writeFile } from 'node:fs/promises';
import { test, expect } from './fixtures.js';
import type { DshHost } from './dsh/host.js';
import { dismissGettingStarted, openArbiterConfiguration } from './dsh/ui.js';

interface ArbiterState {
  readonly config: {
    readonly enabled: boolean;
    readonly modes: { readonly main: string; readonly subagent: string };
    readonly rules: readonly unknown[];
    readonly reviewer: {
      readonly type: string;
      readonly chat: { readonly provider: string };
    };
    readonly audit: {
      readonly retentionDays: number;
      readonly retentionBytes: number;
    };
  };
  readonly effectiveRevision: string;
  readonly configSnapshotId: string;
  readonly configFormat: string;
  readonly configFormatExplicit: boolean;
  readonly fileRevision: string | null;
  readonly invalidConfigError: string | null;
  readonly configHistory: readonly {
    readonly entry: string;
    readonly revision: string;
    readonly snapshotId: string;
  }[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function record(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError(`${path} must be an object`);
  return value;
}

function text(value: unknown, path: string): string {
  if (typeof value !== 'string')
    throw new TypeError(`${path} must be a string`);
  return value;
}

function bool(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean')
    throw new TypeError(`${path} must be a boolean`);
  return value;
}

function num(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value))
    throw new TypeError(`${path} must be a number`);
  return value;
}

function list(value: unknown, path: string): readonly unknown[] {
  if (!Array.isArray(value)) throw new TypeError(`${path} must be a list`);
  return value;
}

/** Validate the parts this spec asserts instead of trusting the API shape. */
function asState(value: unknown): ArbiterState {
  const root = record(value, 'state');
  const config = record(root['config'], 'config');
  const modes = record(config['modes'], 'config.modes');
  const reviewer = record(config['reviewer'], 'config.reviewer');
  const chat = record(reviewer['chat'], 'config.reviewer.chat');
  const audit = record(config['audit'], 'config.audit');
  const history = list(root['configHistory'], 'configHistory').map((row) => {
    const entry = record(row, 'configHistory[]');
    return {
      entry: text(entry['entry'], 'entry'),
      revision: text(entry['revision'], 'revision'),
      snapshotId: text(entry['snapshotId'], 'snapshotId'),
    };
  });
  const invalid = root['invalidConfigError'];
  const fileRevision = root['fileRevision'];
  return {
    config: {
      enabled: bool(config['enabled'], 'config.enabled'),
      modes: {
        main: text(modes['main'], 'modes.main'),
        subagent: text(modes['subagent'], 'modes.subagent'),
      },
      rules: list(config['rules'], 'config.rules'),
      reviewer: {
        type: text(reviewer['type'], 'reviewer.type'),
        chat: { provider: text(chat['provider'], 'reviewer.chat.provider') },
      },
      audit: {
        retentionDays: num(audit['retentionDays'], 'audit.retentionDays'),
        retentionBytes: num(audit['retentionBytes'], 'audit.retentionBytes'),
      },
    },
    effectiveRevision: text(root['effectiveRevision'], 'effectiveRevision'),
    configSnapshotId: text(root['configSnapshotId'], 'configSnapshotId'),
    configFormat: text(root['configFormat'], 'configFormat'),
    configFormatExplicit: bool(
      root['configFormatExplicit'],
      'configFormatExplicit',
    ),
    fileRevision:
      fileRevision === null ? null : text(fileRevision, 'fileRevision'),
    invalidConfigError:
      invalid === null ? null : text(invalid, 'invalidConfigError'),
    configHistory: history,
  };
}

async function readState(dsh: DshHost): Promise<ArbiterState> {
  const response = await fetch(`${dsh.origin}/api/arbiter/state`, {
    headers: { cookie: `${dsh.cookie.name}=${dsh.cookie.value}` },
  });
  expect(response.status).toBe(200);
  return asState(await response.json());
}

/**
 * Append a patch row for the arbiter entry.
 *
 * A later row with the same id replaces the whole config, which is exactly the
 * "user rewrote the file" case. Appending block YAML keeps the file valid in
 * both the JSON and YAML layouts the host may have persisted.
 */
async function appendPatch(
  dsh: DshHost,
  config: Record<string, unknown>,
): Promise<void> {
  const previous = await readFile(dsh.documentPath, 'utf8');
  // A JSON list (what the fixture writes) is a YAML flow sequence; convert its
  // rows to block entries so a block row can be appended in the same document.
  const head = previous.trimStart().startsWith('[')
    ? `${list(JSON.parse(previous), 'patch')
        .map((row) => `- ${JSON.stringify(record(row, 'patch[]'))}`)
        .join('\n')}\n`
    : previous;
  const row = `- id: arbiter\n  name: dsh-arbiter\n  config: ${JSON.stringify(config)}\n`;
  await writeFile(
    dsh.documentPath,
    `${head}${head.endsWith('\n') ? '' : '\n'}${row}`,
    'utf8',
  );
}

async function waitForState(
  dsh: DshHost,
  predicate: (state: ArbiterState) => boolean,
  timeoutMs = 20_000,
): Promise<ArbiterState> {
  const deadline = Date.now() + timeoutMs;
  let latest = await readState(dsh);
  while (!predicate(latest)) {
    if (Date.now() > deadline)
      throw new Error(
        `state did not converge: ${JSON.stringify({
          revision: latest.effectiveRevision,
          fileRevision: latest.fileRevision,
          error: latest.invalidConfigError,
        })}`,
      );
    await new Promise((resolve) => setTimeout(resolve, 250));
    latest = await readState(dsh);
  }
  return latest;
}

test.describe('configuration lifecycle', () => {
  test.use({ firstInstall: true });

  test(
    'a fresh profile applies the first-release defaults without taking over a session',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      const pageErrors: string[] = [];
      page.on('pageerror', (error) => pageErrors.push(error.message));
      const state = await readState(dsh);
      expect(state.invalidConfigError).toBeNull();
      expect(state.config).toMatchObject({
        enabled: true,
        modes: { main: 'normal', subagent: 'strict' },
        rules: [],
        reviewer: { type: 'chat', chat: { provider: 'session' } },
        audit: { retentionDays: 30, retentionBytes: 1024 ** 3 },
      });
      expect(state.configFormat).toBe('arbiter-config-v1');
      expect(state.configFormatExplicit).toBe(false);
      // First install records exactly one startup activation.
      expect(
        state.configHistory.filter((row) => row.entry === 'startup'),
      ).toHaveLength(1);
      expect(state.configHistory[0]?.snapshotId).toBe(state.configSnapshotId);

      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      await expect(plugin.getByText(/^文件修订 [0-9a-f]{8}$/)).toBeVisible();
      await expect(
        plugin.getByText(new RegExp(`^生效修订 ${state.effectiveRevision}$`)),
      ).toBeVisible();
      await expect(
        plugin.getByText(`内容快照 ${state.configSnapshotId}`),
      ).toBeVisible();
      await expect(
        plugin.getByText(/格式 arbiter-config-v1（未声明，沿用旧前缀语义）/),
      ).toBeVisible();
      // Loading the page alone must not change the effective revision.
      expect((await readState(dsh)).effectiveRevision).toBe(
        state.effectiveRevision,
      );
      expect(pageErrors).toEqual([]);
    },
  );

  test(
    'saves a UI draft and shows saved plus effective identities',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      const before = await readState(dsh);
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      const mode = plugin.getByLabel('主会话审批模式', { exact: false });
      await expect(mode).toHaveValue('normal');
      await mode.selectOption('progress');
      await expect(plugin.locator('[data-arbiter-save-status]')).toHaveText(
        '草稿未保存；当前生效配置未改变。',
      );

      // Editing the draft alone does not apply anything.
      expect((await readState(dsh)).effectiveRevision).toBe(
        before.effectiveRevision,
      );

      const [save] = await Promise.all([
        page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/arbiter/config/save',
        ),
        plugin.getByRole('button', { name: '保存并应用' }).click(),
      ]);
      expect(save.status()).toBe(200);
      expect(await save.json()).toMatchObject({
        ok: true,
        saved: true,
        effective: true,
        changed: true,
      });

      const after = await waitForState(
        dsh,
        (state) =>
          state.config.modes.main === 'progress' &&
          state.effectiveRevision !== before.effectiveRevision,
      );
      await expect(
        plugin.locator('[data-arbiter-save-status="saved"]'),
      ).toHaveText('已保存并生效。');
      await expect(
        plugin.getByText(new RegExp(`^生效修订 ${after.effectiveRevision}$`)),
      ).toBeVisible();
      // The file revision is a hash of the written patch: it must move too.
      expect(after.fileRevision).not.toBe(before.fileRevision);
      // One more activation, attributed to the UI save.
      expect(after.configHistory).toHaveLength(before.configHistory.length + 1);
      expect(after.configHistory[0]?.entry).toBe('ui');

      // A refresh keeps the effective configuration and the new identities.
      await page.reload();
      await dismissGettingStarted(page);
      await openArbiterConfiguration(page);
      await expect(
        page
          .locator('[data-arbiter-root]')
          .getByText(new RegExp(`^生效修订 ${after.effectiveRevision}$`)),
      ).toBeVisible();
      expect((await readState(dsh)).config.modes.main).toBe('progress');
    },
  );

  test(
    'an external patch replacement applies through the same validation path',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      const before = await readState(dsh);
      await expect(plugin.getByText(/^文件修订 [0-9a-f]{8}$/)).toBeVisible();

      await appendPatch(dsh, {
        modes: { main: 'strict' },
        audit: { retentionDays: 14 },
      });

      const after = await waitForState(
        dsh,
        (state) =>
          state.config.modes.main === 'strict' &&
          state.effectiveRevision !== before.effectiveRevision,
      );
      expect(after.config.audit.retentionDays).toBe(14);
      // The 1 GiB default survives a partial external edit.
      expect(after.config.audit.retentionBytes).toBe(1024 ** 3);
      expect(after.configHistory[0]?.entry).toBe('file');
      expect(after.fileRevision).not.toBe(before.fileRevision);

      await plugin.getByRole('button', { name: '重新读取' }).click();
      await expect(
        plugin.getByText(new RegExp(`^生效修订 ${after.effectiveRevision}$`)),
      ).toBeVisible();
      await expect(plugin.getByText(/^文件修订 [0-9a-f]{8}$/)).toBeVisible();
      // No session is enabled by a file replacement.
      expect((await readState(dsh)).config.enabled).toBe(true);
    },
  );

  test(
    'an invalid external file keeps the effective configuration and reports the load error',
    { tag: '@smoke' },
    async ({ dshPage: page, dsh }) => {
      await openArbiterConfiguration(page);
      const plugin = page.locator('[data-arbiter-root]');
      const before = await readState(dsh);
      await appendPatch(dsh, { format: 'arbiter-config-v9' });
      const after = await waitForState(
        dsh,
        (state) => state.invalidConfigError !== null,
      );
      expect(after.invalidConfigError).toContain('format');
      expect(after.effectiveRevision).toBe(before.effectiveRevision);
      expect(after.configSnapshotId).toBe(before.configSnapshotId);
      expect(after.config.modes.main).toBe(before.config.modes.main);
      // The page only reports what the host state says; reloading the draft
      // surfaces the rejected document while the effective one keeps running.
      await plugin.getByRole('button', { name: '重新读取' }).click();
      await expect(
        page.locator('[data-arbiter-root]').getByText(/配置文件无效/),
      ).toBeVisible();
      await expect(
        plugin.getByText(new RegExp(`^生效修订 ${before.effectiveRevision}$`)),
      ).toBeVisible();
    },
  );
});
