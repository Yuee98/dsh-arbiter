/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

const copyAttributes = new Set([
  'title',
  'label',
  'description',
  'hint',
  'placeholder',
  'aria-label',
  'aria-description',
  'alt',
]);

/**
 * Only authored, directly rendered copy is checked. Protocol values, model
 * output, evidence and user content passed as expressions stay untouched.
 * This is a guardrail, not a claim to identify arbitrary strings in helpers.
 * @type {import('eslint').Rule.RuleModule}
 */
export const uiLiteralRule = {
  meta: {
    type: 'problem',
    schema: [],
    messages: {
      literal:
        'Move authored UI copy to the Chinese locale catalog and render t(key): {{copy}}',
    },
  },
  create(context) {
    /** @param {unknown} value @param {import('eslint').Rule.Node} node */
    function check(value, node) {
      if (typeof value !== 'string' || !/[\p{L}\p{N}]/u.test(value)) return;
      context.report({
        node,
        messageId: 'literal',
        data: { copy: value.trim().replace(/\s+/gu, ' ') },
      });
    }
    /** @param {unknown} expression @param {import('eslint').Rule.Node} node */
    function rendered(expression, node) {
      if (!isRecord(expression)) return;
      if (expression['type'] === 'Literal') check(expression['value'], node);
      if (
        expression['type'] === 'TemplateLiteral' &&
        Array.isArray(expression['quasis'])
      ) {
        for (const quasi of expression['quasis']) {
          if (isRecord(quasi) && isRecord(quasi['value']))
            check(quasi['value']['cooked'], node);
        }
      }
      if (expression['type'] === 'ConditionalExpression') {
        rendered(expression['consequent'], node);
        rendered(expression['alternate'], node);
      }
      if (
        expression['type'] === 'LogicalExpression' ||
        (expression['type'] === 'BinaryExpression' &&
          expression['operator'] === '+')
      ) {
        rendered(expression['left'], node);
        rendered(expression['right'], node);
      }
    }
    return {
      /** @param {import('eslint').Rule.Node} node */
      JSXText(node) {
        if (isRecord(node)) check(node['value'], node);
      },
      /** @param {import('eslint').Rule.Node} node */
      JSXAttribute(node) {
        if (!isRecord(node)) return;
        const name = node['name'];
        const value = node['value'];
        if (
          !isRecord(name) ||
          !copyAttributes.has(String(name['name'])) ||
          !isRecord(value)
        )
          return;
        if (value['type'] === 'Literal') check(value['value'], node);
      },
      /** @param {import('eslint').Rule.Node} node */
      JSXExpressionContainer(node) {
        if (!isRecord(node)) return;
        /** @type {unknown} */
        const parent = node['parent'];
        if (isRecord(parent) && parent['type'] === 'JSXAttribute') {
          const name = parent['name'];
          if (!isRecord(name) || !copyAttributes.has(String(name['name'])))
            return;
        }
        rendered(node['expression'], node);
      },
    };
  },
};
