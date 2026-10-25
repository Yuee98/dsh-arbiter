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
  /**
   * The Cordis Loader, read structurally by coexistence detection.
   *
   * It is not part of `HostServices` because this plugin never consumes it as a
   * typed dependency; a stub still needs to serve it through `get('loader')`.
   */
  readonly loader?: unknown;
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
  function get(key: 'loader'): unknown;
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

/** One pre-execute decision, as the host's own type describes it. */
export interface GateDecision {
  readonly kind: string;
  readonly reason?: string;
}

/** A callable form of the plugin's registered `tools/pre-execute` listener. */
export type Gate = (
  execution: {
    readonly callId: string;
    readonly name: string;
    readonly arguments: unknown;
    readonly signal: AbortSignal;
    readonly agent?: { readonly session: unknown };
  },
  next: () => Promise<GateDecision>,
) => Promise<GateDecision>;

/**
 * Capture the plugin's `tools/pre-execute` listener as a callable gate.
 *
 * Pass the returned `on` as the `on` override of {@link createStubContext}: the
 * plugin registers through it, and the test drives the registered listener with
 * the host's own parameter shape. Other events keep the default no-op
 * registration.
 */
export function capturingGate(): {
  readonly on: ContextLike['on'];
  readonly gate: () => Gate;
} {
  let gate: Gate | undefined;
  type Listener = (...args: never[]) => unknown;
  return {
    on(event: string, listener: Listener) {
      if (event !== 'tools/pre-execute') return () => undefined;
      gate = async (execution, next) => {
        const decision: unknown = await Reflect.apply(listener, undefined, [
          execution,
          next,
        ]);
        if (decision === null || typeof decision !== 'object')
          throw new TypeError('gate returned an invalid decision');
        const kind: unknown = Reflect.get(decision, 'kind');
        if (typeof kind !== 'string')
          throw new TypeError('gate returned an invalid decision');
        const reason: unknown = Reflect.get(decision, 'reason');
        return {
          kind,
          ...(typeof reason === 'string' ? { reason } : {}),
        };
      };
      return () => undefined;
    },
    gate: () => {
      if (gate === undefined) throw new Error('gate was not registered');
      return gate;
    },
  };
}
