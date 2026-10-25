import type { AnyHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { SetupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/** Opt in per test file; real fetch is intercepted at the network boundary. */
export function setupApiMock(...handlers: readonly AnyHandler[]): SetupServer {
  const server = setupServer(...handlers);
  beforeAll(() => {
    server.listen({ onUnhandledFrame: 'error' });
  });
  afterEach(() => {
    server.resetHandlers();
  });
  afterAll(() => {
    server.close();
  });
  return server;
}
