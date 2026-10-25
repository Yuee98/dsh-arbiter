import { createServer } from 'node:http';
import type { IncomingHttpHeaders, Server } from 'node:http';

/**
 * A controllable local provider endpoint for the connection-test E2E.
 *
 * The probe must be cancellable while in flight, which a closed port cannot
 * demonstrate: the connection fails before the user can act. This server holds
 * each request open and records it, so a test can observe the request arriving,
 * close the dialog, and then assert that the client actually aborted.
 *
 * It answers with a contracted chat completion shape when released, and never
 * requires a credential.
 */
export interface PendingCall {
  readonly authorization: string | null;
  /** Headers the provider received, so a test can prove no secret leaked. */
  readonly headers: IncomingHttpHeaders;
  /** Settles the request with a valid assistant message. */
  readonly release: () => void;
  /** Ends the request without a body, as a provider failure would. */
  readonly fail: () => void;
  /** Resolves when the client aborts this request. */
  readonly aborted: Promise<boolean>;
}

export interface HoldingProvider {
  readonly origin: string;
  /** Every request the probe sent, in arrival order. */
  readonly calls: PendingCall[];
  readonly stop: () => Promise<void>;
}

const CHAT_COMPLETION = JSON.stringify({
  id: 'probe-completion',
  object: 'chat.completion',
  created: 0,
  model: 'probe-model',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: JSON.stringify({
          risk: 1,
          authorized: 8,
          secrets: false,
          destructive: false,
          egress: false,
          bulk: false,
        }),
      },
    },
  ],
  usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
});

/**
 * Start the holding provider on an OS-assigned port.
 *
 * `hold: true` keeps the response open until the test releases or fails it;
 * `hold: false` answers immediately with a valid completion.
 */
export function startHoldingProvider(
  options: { readonly hold: boolean } = { hold: true },
): Promise<HoldingProvider> {
  const calls: PendingCall[] = [];
  const server: Server = createServer((request, response) => {
    let abortedResolve = (): void => undefined;
    const aborted = new Promise<boolean>((resolve) => {
      abortedResolve = () => {
        resolve(true);
      };
    });
    const settle = (): void => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(CHAT_COMPLETION);
    };
    const fail = (): void => {
      response.writeHead(500, { 'content-type': 'text/plain' });
      response.end('provider failed');
    };
    const call: PendingCall = {
      authorization: request.headers.authorization ?? null,
      headers: request.headers,
      release: settle,
      fail,
      aborted,
    };
    calls.push(call);
    request.on('aborted', () => {
      abortedResolve();
    });
    response.on('close', () => {
      if (!response.writableEnded) abortedResolve();
    });
    void request.resume();
    if (!options.hold) settle();
  });
  return new Promise<HoldingProvider>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('holding provider did not bind a port'));
        return;
      }
      resolve({
        origin: `http://127.0.0.1:${String(address.port)}`,
        calls,
        stop: () =>
          new Promise<void>((done) => {
            server.close(() => {
              done();
            });
            for (const call of calls) call.fail();
          }),
      });
    });
  });
}
