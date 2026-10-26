import { http, HttpResponse, type AnyHandler } from 'msw';
import { setupServer } from 'msw/node';
import type { SetupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll } from 'vitest';

/**
 * Baseline answers every case shares.
 *
 * The conflict overlay refreshes on mount, so a page rendered by any test now
 * requests the coexistence route. A default "no conflict" answer keeps those
 * tests focused on their own subject; a case that cares about a conflict
 * overrides it with its own handler.
 */
const BASELINE: readonly AnyHandler[] = [
  http.get('*/api/arbiter/coexistence', () =>
    HttpResponse.json({ ok: true, coexistence: null }),
  ),
];

/** Opt in per test file; real fetch is intercepted at the network boundary. */
export function setupApiMock(...handlers: readonly AnyHandler[]): SetupServer {
  const server = setupServer(...BASELINE, ...handlers);
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
