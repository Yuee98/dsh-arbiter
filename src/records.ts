/**
 * Durable plugin-record access for the host half.
 *
 * Session events written by a plugin must carry the envelope's `ignorable`
 * marker; a reader that does not know the type then retains and skips the
 * record instead of refusing the whole log. The only public writer that adds
 * that marker is `appendPluginRecord` from `@deepseek-ai/dsh-session`.
 *
 * Resolution order:
 *   1. a plain `import('@deepseek-ai/dsh-session')` — works when the profile
 *      installs the package or the host maps it for a linked plugin;
 *   2. otherwise, resolve it from the *running host's own installation*,
 *      located through the CLI entry in `process.argv` and Node's normal
 *      package resolution there.
 *
 * Neither path is a hard-coded filesystem location, and neither falls back to
 * `session.append`: an incompatible record would make the session unreadable.
 */

/** Narrow an unknown module namespace to the two functions we call. */
function isSessionRecordApi(value: unknown): value is SessionRecordApi {
  if (typeof value !== 'object' || value === null) return false;
  return typeof Reflect.get(value, 'appendPluginRecord') === 'function';
}

export interface SessionRecordApi {
  appendPluginRecord(
    session: PluginRecordSession,
    type: string,
    data: Record<string, unknown>,
  ): number;
  pluginRecordOf?(event: unknown): PluginRecordLike | undefined;
}

/** The slice of a Session that record writes need. */
export interface PluginRecordSession {
  append?: (type: string, data: unknown) => unknown;
  snapshotEvents?: () => readonly PluginRecordEventLike[];
}

export interface PluginRecordEventLike {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: unknown;
  readonly ignorable?: boolean;
}

export interface PluginRecordLike {
  readonly type: string;
  readonly seq: number;
  readonly time: number | undefined;
  readonly data: unknown;
}

import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

let loaded: SessionRecordApi | null = null;
let loadError: string | null = null;
let loading: Promise<SessionRecordApi | null> | null = null;

/**
 * Resolve the session package once. Failures are retained so the caller can
 * report a concrete diagnostic instead of silently degrading.
 */
export function loadSessionRecordApi(): Promise<SessionRecordApi | null> {
  if (loaded !== null) return Promise.resolve(loaded);
  if (loading !== null) return loading;
  loading = importSessionModule()
    .then((module: unknown) => {
      const api: SessionRecordApi | undefined = isSessionRecordApi(module)
        ? module
        : undefined;
      if (api === undefined) {
        loadError =
          '@deepseek-ai/dsh-session exposes no appendPluginRecord(); session records are unavailable';
        return null;
      }
      loaded = api;
      loadError = null;
      return loaded;
    })
    .catch((error: unknown) => {
      loadError = `cannot resolve @deepseek-ai/dsh-session: ${
        error instanceof Error ? error.message : String(error)
      }`;
      return null;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

/**
 * The running host's installation root, derived from its own CLI entry.
 *
 * The desktop CLI lives at `<root>/node_modules/@deepseek-ai/dsh-desktop-host/lib/cli.js`
 * and a source checkout at `<root>/node_modules/@deepseek-ai/dsh/lib/bin.js`.
 * Nothing here assumes a particular absolute prefix.
 */
export function hostInstallationRoot(
  argv: readonly string[] = process.argv,
): string | undefined {
  for (const arg of argv) {
    // Node's argv uses native separators, including mixed paths from Git Bash.
    // Keep the original prefix for the native resolver after locating it.
    const marker = arg
      .replaceAll('\\', '/')
      .indexOf('/node_modules/@deepseek-ai/');
    if (marker > 0) return arg.slice(0, marker);
  }
  return undefined;
}

/** Import the session module, preferring plain resolution. */
async function importSessionModule(): Promise<unknown> {
  try {
    return await import('@deepseek-ai/dsh-session');
  } catch (primary: unknown) {
    const root = hostInstallationRoot();
    if (root === undefined) throw primary;
    // Anchor Node's resolver at the host installation, so the package's own
    // `exports` map and dependencies apply exactly as they do for the host.
    const anchor = createRequire(join(root, 'package.json'));
    const entry = anchor.resolve('@deepseek-ai/dsh-session');
    return await import(pathToFileURL(entry).href);
  }
}

/** The retained resolution failure, or `null` when the API is available. */
export function sessionRecordError(): string | null {
  return loadError;
}

/** Whether the public writer resolved (records can be appended at all). */
export function sessionRecordReady(): boolean {
  return loaded !== null;
}

/**
 * Append one ignorable plugin record.
 *
 * @returns `'written'` on success, or a `failed: …` description. A failure
 * never degrades to `session.append`: that would write an event the cold
 * reader refuses.
 */
export function appendRecord(
  session: PluginRecordSession,
  type: string,
  data: Record<string, unknown>,
): 'written' | `failed: ${string}` {
  if (loaded === null) {
    return `failed: ${loadError ?? 'session record API is not loaded'}`;
  }
  try {
    loaded.appendPluginRecord(session, type, data);
    return 'written';
  } catch (error) {
    return `failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}

/**
 * Read one committed event as a plugin record.
 *
 * Falls back to the data-only envelope check when the package did not export
 * `pluginRecordOf`: `ignorable === true` plus a `plugin:`-namespaced type is
 * the same predicate the host applies, and it needs no host code.
 */
export function recordOf(
  event: PluginRecordEventLike,
): PluginRecordLike | undefined {
  if (loaded?.pluginRecordOf !== undefined) {
    return loaded.pluginRecordOf(event);
  }
  if (event.ignorable !== true) return undefined;
  if (
    !/^plugin:[a-z0-9][a-z0-9._-]*(?:\/[a-z0-9][a-z0-9._-]*)*$/u.test(
      event.type,
    )
  ) {
    return undefined;
  }
  return {
    type: event.type,
    seq: event.seq,
    time: event.time,
    data: event.data,
  };
}
