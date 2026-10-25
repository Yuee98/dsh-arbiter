import {
  clearRoute,
  logRoute,
  logsRoute,
  replayRoute,
  suggestionsRoute,
} from './audit-routes.js';
import { credentialsRoute, testRoute, validateRoute } from './config-routes.js';
import { ConfigurationAccess } from './configuration.js';
import { jsonResponse } from './http.js';
import { statePayload } from './state.js';
import { analyzeRoute, SuggestionActions } from './suggestion-routes.js';
import type { FetchRouteLike, HostEnvironment } from './types.js';

/** Routes share one configuration accessor and retain optional-service injection. */
export function registerRoutes(host: HostEnvironment): void {
  const configuration = new ConfigurationAccess(host);
  host.ctx.inject(['connection'], (registrationContext) => {
    const connection = registrationContext.get('connection');
    if (connection === undefined) return;
    const routes: FetchRouteLike[] = [
      {
        path: '/api/arbiter/state',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: () =>
          Promise.resolve(jsonResponse(statePayload(host, configuration))),
      },
      {
        path: '/api/arbiter/config/save',
        methods: ['POST'],
        requestBody: 'buffered',
        fetch: (request) => configuration.save(request),
      },
      validateRoute(),
      credentialsRoute(host),
      testRoute(host),
      logsRoute(host),
      logRoute(host),
      suggestionsRoute(host),
      analyzeRoute(host),
      new SuggestionActions(host, configuration).route(),
      replayRoute(host),
      clearRoute(host),
    ];
    host.ctx.effect(() => {
      const disposers = routes.map((route) => connection.fetch.register(route));
      return () => {
        for (const dispose of disposers) dispose();
      };
    }, 'arbiter routes');
  });
}
