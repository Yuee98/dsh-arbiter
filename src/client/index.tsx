import type { ReactNode } from 'react';
import { ArbiterI18nProvider } from './i18n-provider.js';
import { createArbiterI18n } from './i18n.js';
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
  ctx.slots.inject('plugins.bundle.config', () =>
    ctx.slots.register(
      { name: 'plugins.bundle.config', key: 'dsh-arbiter' },
      RegisteredArbiterPage,
    ),
  );
}

export const inject = ['slots', 'locale'];
