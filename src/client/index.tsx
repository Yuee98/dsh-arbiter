import type { ReactNode } from 'react';
import {
  createDenialNodeView,
  denialDefinition,
  DENIAL_NODE_KIND,
} from './components/denial-node.js';
import { ArbiterI18nProvider } from './i18n-provider.js';
import { createArbiterI18n } from './i18n.js';
import { CoexistenceOverlay } from './coexistence-overlay.js';
import { ArbiterPage } from './page.js';
import { createHostBridge } from './host-bridge.js';
import { claimWhenPresent, hostHalfPresent } from './permission-slot-claim.js';
import { subscribeConnectionRecovery } from './host-bridge.js';
import {
  PermissionSelector,
  PERMISSION_SLOT_PRIORITY,
} from './components/permission-selector.js';
import type { ClientContext, SlotProps } from './view-types.js';

export { ArbiterPage } from './page.js';

export function apply(ctx: ClientContext): void {
  const i18n = createArbiterI18n(ctx.locale);
  ctx.effect(() => i18n.dispose, 'Arbiter locale dictionary');
  const bridge = createHostBridge((name) => ctx.get(name));
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
  function RegisteredPermissionSelector(props: SlotProps): ReactNode {
    return (
      <ArbiterI18nProvider i18n={i18n}>
        <PermissionSelector
          sessionId={props.sessionId}
          locked={props.locked}
          bridge={bridge}
        />
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

  // #19: the session denial row. `uiConversation` is injected optionally so a
  // composition without the conversation surface still loads this plugin's
  // configuration page; only the row stays inactive there. The Definition
  // claims each Arbiter `tool/result` and the keyed Chat Node slot renders it,
  // both inside this child plugin's own lifetime.
  ctx.inject(['uiConversation'], (scoped) => {
    const conversations = scoped.uiConversation;
    scoped.effect(
      () => conversations.events.register(denialDefinition),
      'Arbiter denial Definition',
    );
    scoped.slots.inject('conversation.chat.node', () =>
      scoped.slots.register(
        { name: 'conversation.chat.node', key: DENIAL_NODE_KIND },
        createDenialNodeView(i18n),
      ),
    );
  });
  // The host declares this seat after plugins start, so it must be injected.
  // The seat is single-valued: the lowest priority renders, and the host's own
  // occupant sits at 0, so this override has to be negative.
  //
  // The claim is deferred to a host-presence probe: a page whose client bundle
  // outlived its host half (disabled or removed through the manager) must leave
  // the seat to the host's own control instead of showing an inert override.
  ctx.slots.inject('conversation.input.permission', () => {
    // Ownership rides one fiber effect: the probe, the claim and the release
    // are all disposed with this declaration.
    ctx.effect(
      () =>
        claimWhenPresent({
          present: hostHalfPresent,
          claim: () =>
            ctx.slots.register(
              {
                name: 'conversation.input.permission',
                priority: PERMISSION_SLOT_PRIORITY,
              },
              RegisteredPermissionSelector,
            ),
          // A boot that could not reach the host half must not lose the seat for
          // the page's whole lifetime: a recovered connection retries once.
          subscribe: (retry) =>
            subscribeConnectionRecovery((name) => ctx.get(name), retry),
        }),
      'Arbiter permission seat claim',
    );
  });
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
