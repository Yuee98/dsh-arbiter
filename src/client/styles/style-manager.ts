import { ARBITER_COMPILED_CSS } from './compiled-css.js';

export const ARBITER_STYLE_ELEMENT_ID = 'dsh-arbiter-styles';
const activeRegistrations = new Set<symbol>();

export function acquireArbiterStyles(
  cssText: string = ARBITER_COMPILED_CSS,
): () => void {
  if (typeof document === 'undefined') {
    return () => {};
  }

  const sym = Symbol('arbiter-style');
  activeRegistrations.add(sym);

  const existing = document.getElementById(ARBITER_STYLE_ELEMENT_ID);
  if (existing === null) {
    const style = document.createElement('style');
    style.id = ARBITER_STYLE_ELEMENT_ID;
    style.setAttribute('data-arbiter-styles', 'true');
    style.textContent = cssText;
    document.head.appendChild(style);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeRegistrations.delete(sym);
    if (activeRegistrations.size === 0) {
      const el = document.getElementById(ARBITER_STYLE_ELEMENT_ID);
      el?.remove();
    }
  };
}
