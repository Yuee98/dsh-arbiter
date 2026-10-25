import { expect, test } from 'vitest';
import { ConfigurationAccess } from '../../src/host/configuration.js';
import type { HostServices } from '../../src/host/types.js';

test('uses the current config editor when injection changes during request reading', async () => {
  const edits: string[] = [];
  const entry = { options: { id: 'arbiter' } };
  const editor = (name: string) => ({
    documentPath: '/nonexistent/arbiter-config-test.yml',
    entries: () => [entry],
    edit: () => {
      edits.push(name);
      return Promise.resolve();
    },
  });
  const services: HostServices = {
    sessions: undefined,
    llm: undefined,
    approval: undefined,
    presets: undefined,
    workingDirectory: undefined,
    credentials: undefined,
    commands: undefined,
    configEditor: editor('original'),
  };
  let releaseBody = () => {};
  const init = {
    method: 'POST',
    duplex: 'half',
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        releaseBody = () => {
          controller.enqueue(
            new TextEncoder().encode(
              JSON.stringify({ revision: 'r1', config: {} }),
            ),
          );
          controller.close();
        };
      },
    }),
  };
  const request = new Request('http://localhost/api/arbiter/config/save', init);
  const pending = new ConfigurationAccess({ services }).save(request);
  services.configEditor = editor('replacement');
  releaseBody();

  expect((await pending).status).toBe(200);
  expect(edits).toEqual(['replacement']);
});
