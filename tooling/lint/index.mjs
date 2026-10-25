import { fileURLToPath } from 'node:url';
import { boundaryRule } from './boundaries.mjs';
import { uiLiteralRule } from './ui-literals.mjs';
const root = fileURLToPath(new URL('../../', import.meta.url));
/** @type {import('eslint').ESLint.Plugin} */
const engineering = {
  meta: { name: 'arbiter-engineering', version: '1' },
  rules: {
    'module-boundaries': boundaryRule(root),
    'no-ui-literals': uiLiteralRule,
  },
};
export default engineering;
