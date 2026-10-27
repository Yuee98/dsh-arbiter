import { beforeEach, describe, expect, it } from 'vitest';
import { buildCss } from '../../scripts/build-css.ts';
import { apply } from '../../src/client/index.js';
import { ARBITER_COMPILED_CSS } from '../../src/client/styles/compiled-css.js';
import {
  acquireArbiterStyles,
  ARBITER_STYLE_ELEMENT_ID,
} from '../../src/client/styles/style-manager.js';
import type { ClientContext } from '../../src/client/view-types.js';

describe('style-manager', () => {
  beforeEach(() => {
    document.getElementById(ARBITER_STYLE_ELEMENT_ID)?.remove();
  });

  it('installs and removes styles with ref-counting and idempotency', () => {
    const release1 = acquireArbiterStyles('/* test-1 */');
    const style1 = document.getElementById(ARBITER_STYLE_ELEMENT_ID);
    expect(style1).not.toBeNull();
    expect(style1?.getAttribute('data-arbiter-styles')).toBe('true');
    expect(
      document.querySelectorAll(`#${ARBITER_STYLE_ELEMENT_ID}`).length,
    ).toBe(1);

    const release2 = acquireArbiterStyles('/* test-2 */');
    expect(
      document.querySelectorAll(`#${ARBITER_STYLE_ELEMENT_ID}`).length,
    ).toBe(1);

    release1();
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).not.toBeNull();

    release1();
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).not.toBeNull();

    release2();
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).toBeNull();

    const release3 = acquireArbiterStyles('/* test-3 */');
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).not.toBeNull();
    release3();
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).toBeNull();
  });

  it('registers arbiter:styles in apply(ctx) and removes on cleanup', () => {
    let effectCleanup: (() => void) | null = null;
    let registeredStylesLabel: string | undefined;

    const mockCtx: ClientContext = {
      locale: {
        register: () => () => {},
        bind: () => (key: string) => key,
        getSnapshot: () => ({}),
        subscribe: () => () => {},
      },
      effect: (cb: () => () => void, label?: string) => {
        if (label === 'arbiter:styles') {
          registeredStylesLabel = label;
          effectCleanup = cb();
        }
      },
      get: () => undefined,
      inject: () => {},
      slots: { inject: () => {}, register: () => () => {} },
    };

    apply(mockCtx);
    expect(registeredStylesLabel).toBe('arbiter:styles');
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).not.toBeNull();

    expect(typeof effectCleanup).toBe('function');
    (effectCleanup as (() => void) | null)?.();
    expect(document.getElementById(ARBITER_STYLE_ELEMENT_ID)).toBeNull();
  });

  it('safely handles missing document / no-op environments', () => {
    const originalDocument = globalThis.document;
    try {
      // @ts-expect-error -- simulating VM evaluation where document is undefined
      delete globalThis.document;
      const release = acquireArbiterStyles();
      expect(typeof release).toBe('function');
      expect(() => {
        release();
      }).not.toThrow();
    } finally {
      globalThis.document = originalDocument;
    }
  });

  it('ensures compiled CSS matches fresh Tailwind v4 compilation', async () => {
    const freshCss = await buildCss({ write: false });
    expect(freshCss).toBe(ARBITER_COMPILED_CSS);
  });
});
