import { realpath, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

export const name = 'arbiter-boundary-roots';

/** Resolve inside the selected host, including the desktop runtime's asar. */
export async function apply(
  _ctx: unknown,
  config: { readonly outputPath: string },
): Promise<void> {
  const entry = process.argv[1];
  if (entry === undefined) throw new Error('host runtime entry is missing');
  const sandboxModule = createRequire(entry).resolve(
    '@deepseek-ai/dsh-sandbox',
  );
  const module: unknown = await import(pathToFileURL(sandboxModule).href);
  if (
    module === null ||
    typeof module !== 'object' ||
    !('writableRoots' in module) ||
    typeof module.writableRoots !== 'function'
  )
    throw new Error('the selected SDK does not expose writableRoots');
  const workspace = await realpath(process.cwd());
  const roots: unknown = Reflect.apply(module.writableRoots, module, [
    { mode: 'workspace-write', workspaceRoot: workspace },
  ]);
  await writeFile(
    config.outputPath,
    JSON.stringify({ entry, sandboxModule, workspace, writableRoots: roots }),
    { flag: 'wx', mode: 0o600 },
  );
}
