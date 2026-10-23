/**
 * Minimal test client plugin: forwards the host's own session command channel.
 *
 * The native permission control reaches `/permission` through
 * `ctx.sessions.binding(sessionId).session.command('/permission <preset>')`.
 * This exposes exactly that call on `window.__dshCommand`, forwarding the
 * string verbatim and returning whatever the host returns.
 *
 * TEST ACCESS POINT, not product behaviour: no decisions, no retries.
 *
 * The Loader imports this module in Node to read its `dsh.client` declaration,
 * so the browser registration is guarded instead of unconditional.
 */
if (typeof window !== 'undefined' && window.__ModuleLoader__ !== undefined) {
  window.__ModuleLoader__.load({
    id: 'pui-command-bridge',
    factory: (require) => {
      var module = { exports: {} };
      var exports = module.exports;

      function apply(ctx) {
        var sessions = ctx.sessions;
        var call = async function (sessionId, text) {
          var live = sessions.binding(sessionId)?.session;
          if (live === undefined) {
            return { ok: false, error: { code: 'NOT_MATERIALIZED', message: 'session not materialized' } };
          }
          return await live.command(text);
        };
        Object.defineProperty(window, '__dshCommand', {
          configurable: true,
          value: {
            call: call,
            sessions: function () {
              return [...sessions.list()].map(function (s) { return s.sessionId; });
            },
          },
        });
        ctx.effect(function () {
          return function () {
            Reflect.deleteProperty(window, '__dshCommand');
          };
        }, 'command-bridge: window handle');
      }

      var inject = ['sessions'];

      module.exports = { apply: apply, inject: inject };
      return module.exports;
    },
  });
}
