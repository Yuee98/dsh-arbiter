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
  const navigation = ctx.pluginNavigation;
  return navigation === undefined
    ? undefined
    : () => {
        navigation.openList();
      };
}

export const inject = ['slots', 'locale'];
