import { render } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';
import type { ReactElement } from 'react';

import { createArbiterI18n } from '../../src/client/i18n.js';
import { ArbiterI18nProvider } from '../../src/client/i18n-provider.js';
import { createTestLocale } from './test-locale.js';

export function renderClient(
  ui: ReactElement,
  options: { readonly locale?: 'zh' | 'en' } = {},
) {
  const locale = createTestLocale(options.locale);
  const i18n = createArbiterI18n(locale);
  const view = render(
    <ArbiterI18nProvider i18n={i18n}>{ui}</ArbiterI18nProvider>,
  );
  return { ...view, user: userEvent.setup(), locale, i18n };
}
