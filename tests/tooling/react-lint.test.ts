import { ESLint } from 'eslint';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const root = fileURLToPath(new URL('../../', import.meta.url));
const eslint = new ESLint({ cwd: root });

async function rules(
  source: string,
  filePath = 'src/client/i18n-provider.tsx',
): Promise<readonly string[]> {
  const results = await eslint.lintText(source, { filePath });
  return results.flatMap((result) =>
    result.messages.map((message) => message.ruleId ?? 'fatal'),
  );
}

describe('React component lifetime safeguards', () => {
  it('also checks effects declared in .ts hooks', async () => {
    await expect(
      rules(
        `import { useEffect } from 'react';
        export function useTick(onTick: () => void) {
          useEffect(() => { setInterval(onTick, 100); }, [onTick]);
        }`,
        'src/client/i18n.ts',
      ),
    ).resolves.toContain('@eslint-react/web-api-no-leaked-interval');
  });

  it('rejects nested component definitions that remount on each parent render', async () => {
    await expect(
      rules(`export function View(props: { readonly label: string }) {
        function Child() { return <span>{props.label}</span>; }
        return <Child />;
      }`),
    ).resolves.toContain('@eslint-react/no-nested-component-definitions');
  });

  it('permits a stable component declared at module scope', async () => {
    await expect(
      rules(`function Child(props: { readonly label: string }) {
        return <span>{props.label}</span>;
      }
      export function View(props: { readonly label: string }) {
        return <Child label={props.label} />;
      }`),
    ).resolves.toEqual([]);
  });

  it.each([
    ['interval', 'setInterval(props.onTick, 100);'],
    ['timeout', 'setTimeout(props.onTick, 100);'],
    ['event-listener', "window.addEventListener('resize', props.onTick);"],
  ])('rejects an uncleaned %s in an effect', async (kind, operation) => {
    await expect(
      rules(`import { useEffect } from 'react';
        export function View(props: { readonly onTick: () => void }) {
          useEffect(() => { ${operation} }, [props.onTick]);
          return null;
        }`),
    ).resolves.toContain(`@eslint-react/web-api-no-leaked-${kind}`);
  });

  it('accepts matching cleanup for listeners and both timer types', async () => {
    await expect(
      rules(`import { useEffect } from 'react';
        export function View(props: { readonly onTick: () => void }) {
          useEffect(() => {
            const interval = setInterval(props.onTick, 100);
            const timeout = setTimeout(props.onTick, 200);
            window.addEventListener('resize', props.onTick);
            return () => {
              clearInterval(interval);
              clearTimeout(timeout);
              window.removeEventListener('resize', props.onTick);
            };
          }, [props.onTick]);
          return null;
        }`),
    ).resolves.toEqual([]);
  });
});
