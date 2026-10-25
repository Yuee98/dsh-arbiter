import type { ReactNode } from 'react';
import { ArbiterI18nProvider } from './i18n-provider.js';
import { createArbiterI18n } from './i18n.js';
import { ArbiterPage } from './page.js';
import { createHostBridge } from './host-bridge.js';
import { hostHalfPresent } from './permission-slot-claim.js';
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
    // are all cancelled or disposed with this declaration.
    ctx.effect(() => {
      let claim: (() => void) | null = null;
      let cancelled = false;
      hostHalfPresent()
        .then((present) => {
          if (cancelled || !present) return;
          claim = ctx.slots.register(
            {
              name: 'conversation.input.permission',
              priority: PERMISSION_SLOT_PRIORITY,
            },
            RegisteredPermissionSelector,
          );
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
        claim?.();
        claim = null;
      };
    }, 'Arbiter permission seat claim');
  });
}

export const inject = ['slots', 'locale'];
