import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';
import { AnnotationWorkspace, AnnotationWriteError } from './web-workspace.js';
import type { WebScope } from './web-workspace.js';
import { checked } from './workflow-validation.js';
import { webMutation } from './web-validation.js';

const HTML =
  '<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>工作流标注</title><link rel="stylesheet" href="/style.css"></head><body><div id="app"></div><script type="module" src="/app.js"></script></body></html>';
function send(
  response: ServerResponse,
  status: number,
  body: string,
  type = 'application/json; charset=utf-8',
): void {
  response.writeHead(status, {
    'content-type': type,
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
    'content-security-policy':
      "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  });
  response.end(body);
}
async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (request.headers['content-type'] !== 'application/json')
    throw new Error('JSON_REQUIRED');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request) {
    if (!Buffer.isBuffer(chunk)) throw new Error('INVALID_BODY');
    length += chunk.length;
    if (length > 192 * 1024) throw new Error('BODY_TOO_LARGE');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}
export async function startAnnotationServer(
  scope: WebScope,
  port = 0,
): Promise<{
  readonly url: string;
  readonly workspace: AnnotationWorkspace;
  close(): Promise<void>;
}> {
  if (!Number.isInteger(port) || port < 0 || port > 65535)
    throw new Error('invalid port');
  const workspace = await AnnotationWorkspace.open(scope);
  const bundle = await build({
    entryPoints: [new URL('./web-client.ts', import.meta.url).pathname],
    bundle: true,
    write: false,
    platform: 'browser',
    format: 'esm',
    minify: true,
    define: { 'process.env.NODE_ENV': '"production"' },
  });
  const script = bundle.outputFiles[0]?.text;
  if (script === undefined) throw new Error('browser bundle was not built');
  const style = await readFile(
    new URL('./web-style.css', import.meta.url),
    'utf8',
  );
  const token = randomBytes(32).toString('hex');
  let origin = '';
  const route = async (
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> => {
    if (
      request.headers.host !== new URL(origin).host ||
      (request.headers.origin !== undefined &&
        request.headers.origin !== origin)
    ) {
      send(response, 403, JSON.stringify({ error: 'ORIGIN_REJECTED' }));
      return;
    }
    const path = new URL(request.url ?? '/', origin).pathname;
    if (
      request.method === 'GET' &&
      ['/', '/app.js', '/style.css'].includes(path)
    ) {
      send(
        response,
        200,
        path === '/' ? HTML : path === '/app.js' ? script : style,
        path === '/'
          ? 'text/html; charset=utf-8'
          : path === '/app.js'
            ? 'text/javascript; charset=utf-8'
            : 'text/css; charset=utf-8',
      );
      return;
    }
    if (request.headers['x-annotation-token'] !== token) {
      send(response, 403, JSON.stringify({ error: 'TOKEN_REQUIRED' }));
      return;
    }
    try {
      let result: unknown;
      if (request.method === 'GET' && path === '/api/bootstrap')
        result = await workspace.bootstrap();
      else if (
        request.method === 'POST' &&
        ['/api/point', '/api/opinions', '/api/rebase'].includes(path)
      ) {
        const value = checked<{ token: string; revision?: number }>(
          {
            type: 'object',
            additionalProperties: false,
            required:
              path === '/api/rebase' ? ['token', 'revision'] : ['token'],
            properties: {
              token: { type: 'string', pattern: '^[a-f0-9-]{36}$' },
              revision: { type: 'integer', minimum: 0 },
            },
          },
          await jsonBody(request),
        );
        result =
          path === '/api/point'
            ? await workspace.point(value.token)
            : path === '/api/opinions'
              ? await workspace.opinions(value.token)
              : await workspace.rebase(value.token, value.revision ?? -1);
      } else if (
        request.method === 'POST' &&
        ['/api/save', '/api/confirm'].includes(path)
      ) {
        const value = webMutation(await jsonBody(request));
        result =
          path === '/api/save'
            ? await workspace.save(value)
            : await workspace.confirm(value);
      } else {
        send(response, 404, JSON.stringify({ error: 'NOT_FOUND' }));
        return;
      }
      send(response, 200, JSON.stringify(result));
    } catch (error) {
      // Source paths, IDs and source-validation exception payloads stay server-side.
      const conflict =
        error instanceof Error &&
        /conflict|changed|EEXIST/u.test(error.message);
      send(
        response,
        conflict ? 409 : 400,
        JSON.stringify({
          error:
            error instanceof AnnotationWriteError
              ? error.message
              : conflict
                ? 'CONFLICT_REVIEW_REQUIRED'
                : 'REQUEST_FAILED_CHECK_INPUT_OR_STORAGE',
          ...(error instanceof AnnotationWriteError
            ? { published: error.published }
            : {}),
        }),
      );
    }
  };
  const server = createServer((request, response) => {
    route(request, response).catch(() => {
      if (!response.headersSent)
        send(response, 500, JSON.stringify({ error: 'SERVER_ERROR' }));
      else response.destroy();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string')
    throw new Error('loopback server has no address');
  origin = `http://127.0.0.1:${String(address.port)}`;
  return {
    url: `${origin}/#${token}`,
    workspace,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error !== undefined) reject(error);
          else resolve();
        });
        server.closeIdleConnections();
      }),
  };
}
