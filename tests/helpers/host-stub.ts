import type {
  ConfigEditorLike,
  ConnectionLike,
  ContextLike,
  HostServices,
  LoggerLike,
  ProfileContextLike,
} from '../../src/host/types.js';

/**
 * A typed host-context stub for lifecycle integration tests.
 *
 * Each `get` overload names the public service it serves, so no call site needs
 * a type assertion; the same shape is what the plugin sees in a real host.
 */
export interface StubServices extends Partial<Omit<HostServices, 'presets'>> {
  readonly profileContext?: ProfileContextLike;
  readonly sandboxPolicy?: { readonly defaultMode?: string };
  readonly connection?: ConnectionLike;
  readonly permissionPresets?: HostServices['presets'];
}

type StubMembers = Pick<ContextLike, 'on' | 'effect' | 'inject' | 'logger'>;

export interface StubContextParts {
  readonly ctx: ContextLike;
  readonly disposers: (() => unknown)[];
}

export function createStubContext(
  services: StubServices,
  overrides: Partial<StubMembers> = {},
): StubContextParts {
  const registry: Readonly<Record<string, unknown>> = { ...services };
  const disposers: (() => unknown)[] = [];
  function get(key: 'profileContext'): StubServices['profileContext'];
  function get(key: 'sandboxPolicy'): StubServices['sandboxPolicy'];
  function get(key: 'sessions'): StubServices['sessions'];
  function get(key: 'llm'): StubServices['llm'];
  function get(key: 'approval'): StubServices['approval'];
  function get(key: 'permissionPresets'): StubServices['permissionPresets'];
  function get(key: 'workingDirectory'): StubServices['workingDirectory'];
  function get(key: 'credentials'): StubServices['credentials'];
  function get(key: 'configEditor'): StubServices['configEditor'];
  function get(key: 'commands'): StubServices['commands'];
  function get(key: 'connection'): StubServices['connection'];
  function get(key: string): unknown;
  function get(key: string): unknown {
    return registry[key];
  }
  const logger: LoggerLike = {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
  };
  const members: StubMembers = {
    on: () => () => undefined,
    effect: (callback: () => unknown) => {
      const dispose: unknown = callback();
      if (typeof dispose === 'function')
        disposers.push(() => Reflect.apply(dispose, undefined, []));
    },
    inject: () => undefined,
    logger,
    ...overrides,
  };
  return { ctx: { ...members, get }, disposers };
}

/** A detached config editor over one real patch file. */
export function stubEditor(options: {
  readonly documentPath: string;
  readonly config: () => unknown;
  readonly onEdit: (next: unknown) => void;
  readonly failure?: string;
}): ConfigEditorLike {
  return {
    documentPath: options.documentPath,
    entries: () => [
      {
        options: {
          id: 'arbiter',
          name: 'dsh-arbiter',
          config: options.config(),
        },
      },
    ],
    edit: (_entry, change) => {
      if (options.failure !== undefined)
        return Promise.reject(new Error(options.failure));
      options.onEdit(change(options.config(), {}));
      return Promise.resolve();
    },
  };
}
