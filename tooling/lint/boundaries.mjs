import { isBuiltin } from 'node:module';
import path from 'node:path';

/** @param {unknown} value @returns {value is Record<string, unknown>} */
function isRecord(value) {
  return typeof value === 'object' && value !== null;
}

/** @param {string} file */
export function moduleLayer(file) {
  if (file.startsWith('src/client/')) return 'browser';
  if (
    /^src\/(?:types\.ts$|policy\.ts$|review-contract\/|(?:shared|domain|rules|shell|policy)\/)/u.test(
      file,
    )
  )
    return 'pure';
  return 'server';
}

/** @param {string} file @param {string} source */
export function forbiddenImport(file, source) {
  const layer = moduleLayer(file);
  if (layer === 'server') return null;
  if (
    isBuiltin(source) ||
    /^(?:node:|better-sqlite3(?:\/|$)|sqlite3?(?:\/|$)|@libsql\/)/u.test(source)
  ) {
    return 'Browser and pure-domain modules cannot depend on Node.js or database adapters.';
  }
  if (
    layer === 'pure' &&
    /^(?:react(?:-dom)?(?:\/|$)|@deepseek-ai\/)/u.test(source)
  ) {
    return 'Pure-domain modules cannot depend on React or DSH host/client APIs.';
  }
  if (source.startsWith('.')) {
    const resolved = path.posix.normalize(
      path.posix.join(path.posix.dirname(file), source),
    );
    if (
      layer === 'browser' &&
      /^locale\/[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*\/[a-z][A-Za-z0-9]*\.json$/u.test(
        resolved,
      )
    )
      return null;
    const dependency = moduleLayer(resolved.replace(/\.(?:m?js|jsx)$/u, '.ts'));
    if (layer === 'pure' && dependency !== 'pure')
      return 'Pure-domain modules may only import other pure-domain modules.';
    if (layer === 'browser' && dependency === 'server')
      return 'Browser modules must use the HTTP/host client boundary instead of importing backend code.';
  }
  return null;
}

/** @param {string} root @returns {import('eslint').Rule.RuleModule} */
export function boundaryRule(root) {
  return {
    meta: {
      type: 'problem',
      schema: [],
      messages: {
        forbidden: '{{reason}} Import: {{source}}',
        dynamic:
          'Protected modules require a statically known import/require specifier.',
      },
    },
    create(context) {
      const file = path
        .relative(root, context.filename)
        .split(path.sep)
        .join('/');
      /** @param {unknown} source @param {import('eslint').Rule.Node} node */
      function check(source, node) {
        if (typeof source !== 'string') {
          if (moduleLayer(file) !== 'server')
            context.report({ node, messageId: 'dynamic' });
          return;
        }
        const reason = forbiddenImport(file, source);
        if (reason !== null)
          context.report({
            node,
            messageId: 'forbidden',
            data: { reason, source },
          });
      }
      return {
        ImportDeclaration(node) {
          check(node.source.value, node);
        },
        /** @param {import('eslint').Rule.Node} node */
        TSImportEqualsDeclaration(node) {
          if (!isRecord(node)) return;
          const reference = node['moduleReference'];
          if (
            !isRecord(reference) ||
            reference['type'] !== 'TSExternalModuleReference'
          )
            return;
          const expression = reference['expression'];
          check(isRecord(expression) ? expression['value'] : null, node);
        },
        ExportAllDeclaration(node) {
          check(node.source.value, node);
        },
        ExportNamedDeclaration(node) {
          if (node.source != null) check(node.source.value, node);
        },
        ImportExpression(node) {
          check(
            node.source.type === 'Literal' ? node.source.value : null,
            node,
          );
        },
        CallExpression(node) {
          if (
            node.callee.type !== 'Identifier' ||
            node.callee.name !== 'require'
          )
            return;
          const first = node.arguments[0];
          check(first?.type === 'Literal' ? first.value : null, node);
        },
      };
    },
  };
}
