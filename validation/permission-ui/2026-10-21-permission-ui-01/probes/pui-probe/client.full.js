/**
 * Validation probe (client half).
 *
 * Registers a selector at `conversation.input.permission` with priority 1 so it
 * shadows the native entry at priority 0 while leaving every other host option
 * in its menu. Reads enablement from the probe's public session projection
 * (`puiPermission`) and the host's own `permissions` projection; submits host
 * presets through the same public `/permission <preset>` command path the
 * native control uses.
 */
window.__ModuleLoader__.load({
  id: 'pui-probe',
  factory: (require) => {
    const react = require('react');
    const jsx = require('react/jsx-runtime');
    const e = jsx.jsx;
    const es = jsx.jsxs;

    function useCatalog(ctx) {
      const [catalog, setCatalog] = react.useState(null);
      react.useEffect(() => {
        let stop = false;
        const load = () => {
          ctx.remote.permissionPresets.catalog().then((result) => {
            if (stop || !result.ok) return;
            setCatalog(result.value);
          }).catch(() => {});
        };
        load();
        const off = ctx.remote.$on('permission-presets/catalog-changed', load);
        return () => { stop = true; off(); };
      }, [ctx]);
      return catalog;
    }

    function Selector({ locked, select, useProjection, ctx }) {
      const backend = useProjection('puiPermission');
      const host = useProjection('permissions');
      const catalog = useCatalog(ctx);
      const enabled = backend !== undefined && backend.enabled === true;
      if (catalog === null) return null;
      const boundary = backend?.boundary === 'trusted' ? 'trusted' : 'guarded';
      const currentHost = host?.currentValue ?? '';
      const label = enabled ? `自动审查（Arbiter · ${boundary}）` : `自动审查（Arbiter）`;
      const options = [
        { value: '__arbiter__', label },
        ...catalog.options.filter((option) => option.value !== 'auto').map((option) => ({
          value: option.value,
          label: option.name,
        })),
      ];
      return es('span', {
        'data-pui-selector': 'root',
        'data-pui-enabled': enabled ? '1' : '0',
        style: { display: 'inline-flex', alignItems: 'center', gap: '4px' },
        children: [
          e('select', {
            key: 'trigger',
            'data-pui-selector': 'trigger',
            'aria-label': `权限模式：${enabled ? label : currentHost}`,
            disabled: locked === true,
            value: enabled ? '__arbiter__' : currentHost,
            onChange: (event) => {
              const value = event.target.value;
              if (value === '__arbiter__') select({ arbiter: true, boundary });
              else select({ arbiter: false, preset: value });
            },
            children: options.map((option) => e('option', { key: option.value, value: option.value }, option.label)),
          }),
          e('span', { key: 'dot', 'data-pui-selector': 'dot' }, enabled ? '●' : '○'),
        ],
      });
    }

    function apply(ctx) {
      const sessions = ctx.sessions;
      const call = async (path, payload) => {
        const response = await fetch(`/api/pui${path}`, {
          method: 'POST',
          credentials: 'include',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(payload),
        });
        return response.json();
      };
      const select = async (sessionId, choice) => {
        const live = sessions.binding(sessionId)?.session;
        if (live === undefined) throw new Error('session is not materialized yet');
        if (choice.arbiter === true) {
          const result = await call('/enable', { sessionId, boundary: choice.boundary, origin: 'client-selector' });
          if (!result.ok) throw new Error(`enable failed: ${result.code ?? 'unknown'}`);
          return true;
        }
        // Exit intent first, then the host's own public preset command.
        await call('/disable', { sessionId, reason: 'client-selector' });
        const result = await live.command(`/permission ${choice.preset}`);
        if (!result.ok) throw new Error(`permission switch failed: ${result.error.code}`);
        if (!result.value.matched) throw new Error('host offers no /permission command');
        return true;
      };
      ctx.effect(() => ctx.slots.register({
        name: 'conversation.input.permission',
        priority: 1,
        inject: (sessionId) => ({
          ctx,
          select: (choice) => select(sessionId, choice),
        }),
      }, Selector), 'pui: permission selector');
    }

    return { apply, inject: ['slots', 'sessions', 'remote', 'remote.permissionPresets'] };
  },
});
