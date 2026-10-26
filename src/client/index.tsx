import type { ReactNode } from 'react';
import {
  createDenialNodeView,
  denialDefinition,
  DENIAL_NODE_KIND,
} from './components/denial-node.js';
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
}

export const inject = ['slots', 'locale'];
