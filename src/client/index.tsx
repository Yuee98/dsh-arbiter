import type { ReactNode } from 'react';
import { ArbiterI18nProvider } from './i18n-provider.js';
import { createArbiterI18n } from './i18n.js';
import { CoexistenceOverlay } from './coexistence-overlay.js';
import { ArbiterPage } from './page.js';
import type { ClientContext, SlotProps } from './view-types.js';

export { ArbiterPage } from './page.js';

export function apply(ctx: ClientContext): void {
  const i18n = createArbiterI18n(ctx.locale);
  ctx.effect(() => i18n.dispose, 'Arbiter locale dictionary');
  function RegisteredArbiterPage(props: SlotProps): ReactNode {
    return (
      <ArbiterI18nProvider i18n={i18n}>
        <ArbiterPage {...props} />
      </ArbiterI18nProvider>
    );
  }
  function RegisteredCoexistenceOverlay(): ReactNode {
    return (
      <ArbiterI18nProvider i18n={i18n}>
        <CoexistenceOverlay onOpenPluginManager={openPluginManager(ctx)} />
      </ArbiterI18nProvider>
    );
  }
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'dsh-arbiter' },
      RegisteredArbiterPage,
    ),
  );
  // The conflict reminder must reach a user who is not on Arbiter's page, so it
  // is registered on the frame-wide overlay instead of inside the panel.
  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      { name: 'shell.overlay', id: 'dsh-arbiter.coexistence' },
      RegisteredCoexistenceOverlay,
    ),
  );
}

/**
 * The host's plugin-panel opener, when this deployment provides one.
 *
 * `pluginNavigation` is a client service owned by the plugin manager, so it is
 * read here instead of being assumed: a deployment without that panel shows no
 * navigation button and still shows the reason.
 */
function openPluginManager(ctx: ClientContext): (() => void) | undefined {
  // Looked up through the dynamic-access seam: the plugin manager provides this
  // service, and reading it as a plain property would throw on a deployment that
  // does not. A missing panel therefore costs the shortcut, not the reminder.
  let navigation: unknown;
  try {
    navigation = ctx.reflect?.get('pluginNavigation', false);
  } catch {
    return undefined;
  }
  if (navigation === null || typeof navigation !== 'object') return undefined;
  const openList: unknown = Reflect.get(navigation, 'openList');
  if (typeof openList !== 'function') return undefined;
  return () => {
    Reflect.apply(openList, navigation, []);
  };
}

export const inject = ['slots', 'locale'];
