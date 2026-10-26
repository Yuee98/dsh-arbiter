import type { ReactNode } from 'react';
import { ArbiterI18nProvider } from './i18n-provider.js';
import { createArbiterI18n } from './i18n.js';
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

export const inject = ['slots', 'locale'];
