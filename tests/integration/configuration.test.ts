import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';

import { ConfigurationAccess } from '../../src/host/configuration.js';
import { initializeHost } from '../../src/host/runtime.js';
import type {
  ConfigEditorLike,
  HostEnvironment,
} from '../../src/host/types.js';
import { createStubContext, stubEditor } from '../helpers/host-stub.js';

/** The route reads the live services registry, never a constructor snapshot. */
test('uses the current config editor when injection changes during request reading', async () => {
  const root = await mkdtemp(join(tmpdir(), 'arbiter-config-swap-'));
  const home = join(root, 'home');
  const profileDir = join(home, 'profiles', 'swap');
  const documentPath = join(profileDir, 'cordis.patch.yml');
  await mkdir(profileDir, { recursive: true });
  await writeFile(documentPath, '[]\n', 'utf8');

  const editorCalls: string[] = [];
  const editor = (name: string): ConfigEditorLike =>
    stubEditor({
      documentPath,
      config: () => ({}),
      onEdit: () => editorCalls.push(name),
    });
  const parts = createStubContext({
    profileContext: { home, dir: profileDir, name: 'swap' },
    configEditor: editor('original'),
  });
  const host: HostEnvironment = initializeHost(parts.ctx, {});
  const revision = new ConfigurationAccess(host).fileRevision();

  let releaseBody = (): void => undefined;
  /** Node requires an explicit duplex mode for a streaming request body. */
  const init: RequestInit & { readonly duplex: 'half' } = {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({
                revision: revision ?? 'unavailable',
                config: {},
              }),
            ),
          );
          controller.close();
        };
      },
    }),
  };
  const request = new Request('http://localhost/api/arbiter/config/save', init);
  const pending = new ConfigurationAccess(host).save(request);
  host.services.configEditor = editor('replacement');
  releaseBody();

  try {
    expect((await pending).status).toBe(200);
    expect(editorCalls).toEqual(['replacement']);
  } finally {
    for (const dispose of parts.disposers) dispose();
    await rm(root, { recursive: true, force: true });
  }
});
