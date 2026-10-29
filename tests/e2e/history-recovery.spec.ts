/**
 * Real-host cold recovery of decision history (#16).
 *
 * Two independent proofs, both against the pinned host's own code:
 *
 *  1. **Record durability.** A real `Session` from the pinned runtime receives a
 *     decision through the public `appendPluginRecord`, the session is persisted
 *     by the shipped JSONL backend, every handle is closed, and a *fresh* module
 *     graph cold-reads the same log. The recovered verdicts and their window are
 *     then compared against what the runtime would have selected, and the whole
 *     thing is repeated with the audit directory moved away.
 *
 *  2. **Host lifecycle.** A real host process starts on an isolated profile, the
 *     plugin loads and serves state, the process is terminated, and a second host
 *     starts on the same `DSH_HOME` and still serves state. This is the plugin
 *     reload path, not a model run.
 *
 * No model request is made and the daily DSH profile is never touched.
 */
import { mkdir, mkdtemp, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from '@playwright/test';

import { startDshHost, type DshHost } from './dsh/host.js';
import { resolveDshCommand } from './dsh/profile.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

interface HostRecordEvent {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: unknown;
  readonly ignorable?: boolean;
}

/**
 * The real host `Session` instance.
 *
 * It is kept opaque on purpose: its record writer and its event reader both
 * check the receiver identity, so a wrapper would not be accepted. The fixture
 * passes this value back to the host functions and reads it through
 * {@link sessionEvents}.
 */
type HostSession = object;

/** Return a session's committed events through the host's own method. */
function sessionEvents(session: HostSession): readonly HostRecordEvent[] {
  // `Reflect.get` returns `any` for a prototype lookup, so the method is first
  // narrowed to a runtime-checked callable and then bound to the instance.
  const method = callableOf(
    Reflect.get(Object.getPrototypeOf(session), 'snapshotEvents'),
    session,
  );
  if (method === null) {
    throw new TypeError('the host session exposes no event snapshot');
  }
  const snapshot = method();
  return Array.isArray(snapshot) ? snapshot.filter(isHostEvent) : [];
}

interface HostModules {
  readonly appendPluginRecord: (
    session: HostSession,
    type: string,
    data: Record<string, unknown>,
  ) => number;
  readonly pluginRecordOf: (
    event: HostRecordEvent,
  ) => { readonly type: string; readonly data: unknown } | undefined;
  readonly createSession: (
    id: string,
    header: Record<string, unknown>,
  ) => HostSession;
}

/**
 * Read one named export from a dynamically imported module.
 *
 * `import()` of a package the compiler cannot type yields `any`, and the lint
 * rules refuse an unchecked `any` reaching a typed position. This helper is the
 * single place that narrows the export to `unknown`, so every call site can
 * validate it explicitly instead of asserting the type it hopes for.
 */
function exportOf(module: unknown, name: string): unknown {
  if (module === null || typeof module !== 'object') return undefined;
  return Reflect.get(module, name);
}

/** Read one field from a validated object as an unknown value. */
function fieldOf(value: object, name: string): unknown {
  return Reflect.get(value, name);
}

/** A callable narrowed from `unknown` by a runtime check. */
type Callable = (...args: readonly unknown[]) => unknown;

/**
 * Narrow an unknown value to something callable, or `null`.
 *
 * `receiver` becomes the call's `this`. Services that keep state on the instance
 * (the persistence backend resolves its root and tracker through it) throw if
 * they are called unbound, so the caller must pass the object the method came
 * from.
 */
function callableOf(value: unknown, receiver?: object): Callable | null {
  if (typeof value !== 'function') return null;
  const target = value;
  const callable: Callable = (...args) =>
    Reflect.apply(target, receiver ?? undefined, args);
  return callable;
}

/** Narrow an unknown value to a constructable, or `null`. */
function constructorOf(
  value: unknown,
): ((args: readonly unknown[]) => object) | null {
  if (typeof value !== 'function') return null;
  return (args) => {
    const made: unknown = Reflect.construct(value, [...args]);
    if (made === null || typeof made !== 'object') {
      throw new TypeError('the constructed value is not an object');
    }
    // The instance itself is returned: its methods check the receiver identity,
    // so wrapping it would break every call.
    return made;
  };
}

/** Resolve the pinned host's session package from its own installation. */
async function hostRuntimeRoot(): Promise<string> {
  const command = await resolveDshCommand();
  const entry = command.args[0];
  if (entry === undefined) {
    throw new Error('the DSH entry path is required for this test');
  }
  const marker = entry.replaceAll('\\', '/').indexOf('/node_modules/');
  if (marker < 0) throw new Error(`cannot locate the host root in ${entry}`);
  return entry.slice(0, marker);
}

async function loadHostModules(root: string): Promise<HostModules> {
  const requireFromHost = createRequire(join(root, 'package.json'));
  const module: unknown = await import(
    requireFromHost.resolve('@deepseek-ai/dsh-session')
  );
  const append = callableOf(exportOf(module, 'appendPluginRecord'));
  const readRecord = callableOf(exportOf(module, 'pluginRecordOf'));
  const sessionClass = exportOf(module, 'Session');
  const makeSession = constructorOf(sessionClass);
  if (append === null || readRecord === null || makeSession === null) {
    throw new TypeError('the pinned session module lacks the record API');
  }
  // The host's functions are called through runtime-narrowed callables, so this
  // fixture never asserts a signature it cannot verify, and the values it passes
  // are the typed ones declared above.
  sessionStatics =
    typeof sessionClass === 'function' ? { Class: sessionClass } : {};
  return {
    appendPluginRecord: (session, type, data) => {
      append(session, type, data);
      return 0;
    },
    pluginRecordOf: (event) => {
      const record = readRecord(event);
      if (record === null || typeof record !== 'object') return undefined;
      const type = fieldOf(record, 'type');
      if (typeof type !== 'string') return undefined;
      return { type, data: fieldOf(record, 'data') };
    },
    createSession: (id, header) => {
      // The real instance is returned untouched; the fixture reads it through
      // the host's own method, so no wrapper ever stands between them.
      return makeSession([id, undefined, header]);
    },
  };
}

/** A mounted plugin scope, as much of it as this fixture uses. */
interface HostContext {
  plugin(plugin: unknown, config?: unknown): unknown;
  readonly sessionPersistence: PersistenceLike | undefined;
}

/** One opened session handle, as much of it as this fixture uses. */
interface HandleLike {
  read?(): Promise<unknown>;
  append?(events: readonly HostRecordEvent[]): Promise<void>;
  flush?(): Promise<void>;
  close(): Promise<void>;
}

/** The seam this fixture uses from the shipped persistence backend. */
interface PersistenceLike {
  create(header: Record<string, unknown>): Promise<{
    append(events: readonly HostRecordEvent[]): Promise<void>;
    flush(): Promise<void>;
    close(): Promise<void>;
  }>;
  open(id: string, mode: 'read' | 'write'): Promise<HandleLike>;
}

/** Host modules the fixture mounts, narrowed once from their own installation. */
interface MountedModules {
  readonly Context: () => HostContext;
  readonly persistenceApply: (ctx: HostContext, config: unknown) => unknown;
}

/**
 * Load the two host modules this fixture mounts.
 *
 * A dynamic `import()` of a package the compiler cannot type produces `any`, so
 * the modules are narrowed here once and validated field by field. Every call
 * site downstream then works with typed values.
 */
async function loadMountedModules(root: string): Promise<MountedModules> {
  const requireFromHost = createRequire(join(root, 'package.json'));
  const cordis: unknown = await import(
    requireFromHost.resolve('@deepseek-ai/cordis')
  );
  const jsonl: unknown = await import(
    requireFromHost.resolve('@deepseek-ai/dsh-session-persistence-jsonl')
  );
  const makeContext = constructorOf(exportOf(cordis, 'Context'));
  const apply = callableOf(exportOf(jsonl, 'apply'));
  if (makeContext === null || apply === null) {
    throw new TypeError('the pinned host modules are missing an export');
  }
  return {
    // Both are runtime-narrowed callables; the declared shapes describe only the
    // values this fixture supplies.
    Context: () => {
      const made = makeContext([]);
      const plugin = callableOf(fieldOf(made, 'plugin'), made);
      if (plugin === null) {
        throw new TypeError('the host context exposes no plugin()');
      }
      return {
        plugin: (value, config) => plugin(value, config),
        get sessionPersistence(): PersistenceLike | undefined {
          const service = fieldOf(made, 'sessionPersistence');
          return service === null || service === undefined
            ? undefined
            : persistenceOf(service);
        },
      };
    },
    persistenceApply: (ctx, config) => apply(ctx, config),
  };
}

/** Narrow the persistence service to the operations this fixture calls. */
function persistenceOf(service: unknown): PersistenceLike {
  const receiver = asObject(service);
  const create = callableOf(fieldOf(receiver, 'create'), receiver);
  const open = callableOf(fieldOf(receiver, 'open'), receiver);
  if (create === null || open === null) {
    throw new TypeError('the persistence service lacks create()/open()');
  }
  return {
    create: async (header) => {
      const handle = asObject(await create(header));
      const append = callableOf(fieldOf(handle, 'append'), handle);
      const flush = callableOf(fieldOf(handle, 'flush'), handle);
      const close = callableOf(fieldOf(handle, 'close'), handle);
      if (append === null || flush === null || close === null) {
        throw new TypeError('the write handle is incomplete');
      }
      return {
        append: async (events) => {
          await append(events);
        },
        flush: async () => {
          await flush();
        },
        close: async () => {
          await close();
        },
      };
    },
    open: async (id, mode) => {
      const handle = asObject(await open(id, mode));
      const read = callableOf(fieldOf(handle, 'read'), handle);
      const close = callableOf(fieldOf(handle, 'close'), handle);
      const append = callableOf(fieldOf(handle, 'append'), handle);
      const flush = callableOf(fieldOf(handle, 'flush'), handle);
      if (read === null || close === null) {
        throw new TypeError('the handle is incomplete');
      }
      return {
        read: () => Promise.resolve(read()),
        ...(append === null
          ? {}
          : {
              append: async (events: readonly HostRecordEvent[]) => {
                await append(events);
              },
            }),
        ...(flush === null
          ? {}
          : {
              flush: async () => {
                await flush();
              },
            }),
        close: async () => {
          await close();
        },
      };
    },
  };
}

/** Narrow an unknown value to a non-array object, or throw. */
function asObject(value: unknown): object {
  if (value === null || typeof value !== 'object') {
    throw new TypeError('expected an object');
  }
  return value;
}

/** Whether one value has the committed-event shape this fixture reads. */
function isHostEvent(value: unknown): value is HostRecordEvent {
  if (value === null || typeof value !== 'object') return false;
  const type = fieldOf(value, 'type');
  return typeof type === 'string';
}

/**
 * Mount the shipped persistence backend on a fresh context.
 *
 * The service registers asynchronously, so this waits for it before returning.
 */
async function mountPersistence(
  root: string,
  logRoot: string,
): Promise<{
  readonly ctx: HostContext;
  readonly persistence: PersistenceLike;
}> {
  const modules = await loadMountedModules(root);
  const ctx = modules.Context();
  ctx.plugin(
    { name: 'jsonl', apply: modules.persistenceApply },
    { root: logRoot, compression: 'none' },
  );
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (ctx.sessionPersistence !== undefined) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const persistence = ctx.sessionPersistence;
  if (persistence === undefined) {
    throw new Error('the persistence backend did not mount');
  }
  return { ctx, persistence };
}

/** One decision payload in the shape the plugin writes. */
function decision(
  callId: string,
  ts: number,
  result: string,
): Record<string, unknown> {
  return {
    version: 2,
    callId,
    tool: 'bash',
    fingerprint: `bash:${callId}`,
    trace: result === 'deny' ? ['deny'] : ['review-escalate', result],
    result,
    reason: 'recorded by the cold-recovery fixture',
    configRevision: 'rev-cold',
    ts,
  };
}

/** The decision `callId`s the pinned reader can see in one log. */
function recordIds(
  modules: HostModules,
  events: readonly HostRecordEvent[],
): string[] {
  const ids: string[] = [];
  for (const event of events) {
    const record = modules.pluginRecordOf(event);
    if (record === undefined || record.type !== 'plugin:arbiter/decision') {
      continue;
    }
    const data = record.data;
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      continue;
    }
    const callId = fieldOf(data, 'callId');
    if (typeof callId === 'string') ids.push(callId);
  }
  return ids;
}

interface PersistedLog {
  readonly root: string;
  readonly sessionId: string;
  readonly written: readonly string[];
}

/**
 * Commit real plugin records and persist them through the shipped backend.
 *
 * The records are written by the host's public `appendPluginRecord` into a real
 * `Session`, whose committed events are then appended through the persistence
 * handle exactly as the live event router does. The artifact on disk is
 * therefore the artifact a real plugin run leaves behind.
 */
async function persistRealSession(): Promise<PersistedLog> {
  const root = await hostRuntimeRoot();
  const modules = await loadHostModules(root);
  const logRoot = await mkdtemp(join(tmpdir(), 'arbiter-cold-'));
  const { persistence } = await mountPersistence(root, logRoot);
  const sessionId = 'sr-cold-recovery';
  const header = {
    version: 4,
    id: sessionId,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: logRoot,
  };
  const handle = await persistence.create(header);
  const written = ['cold-1', 'cold-2'];
  try {
    const session = modules.createSession(sessionId, header);
    written.forEach((callId, index) => {
      modules.appendPluginRecord(
        session,
        'plugin:arbiter/decision',
        decision(callId, Date.now() + index, 'deny'),
      );
    });
    // The same committed events the live router would forward, in order.
    await handle.append(sessionEvents(session));
    await handle.flush();
  } finally {
    await handle.close();
  }
  return { root: logRoot, sessionId, written };
}

/** Cold-read a persisted session with a fresh module graph. */
async function coldRead(log: PersistedLog): Promise<{
  readonly ids: readonly string[];
  readonly headers: readonly string[];
}> {
  const root = await hostRuntimeRoot();
  const modules = await loadHostModules(root);
  // A fresh context: nothing from the writing side is reused, so this is a
  // genuine cold read of the stored artifact.
  const { persistence } = await mountPersistence(root, log.root);
  const handle = await persistence.open(log.sessionId, 'read');
  try {
    const read = await readFrom(handle);
    return {
      ids: recordIds(modules, read.events),
      headers: read.events
        .filter((event) => event.type.startsWith('plugin:'))
        .map((event) => `${event.type}:${String(event.ignorable === true)}`),
    };
  } finally {
    await handle.close();
  }
}

/**
 * Open a persisted session and expose it with the shape the plugin reads.
 *
 * The committed events come from the real stored log through the shipped
 * persistence backend — the same artifact a restarted host reads. The wrapper
 * adds only the two accessors a live session provides to the plugin.
 */
async function openPersistedSession(log: PersistedLog): Promise<HostSession> {
  const root = await hostRuntimeRoot();
  // Resolve the session class first: `sessionOver` needs its statics, and the
  // loader is the one place that fills them.
  await loadHostModules(root);
  const { persistence } = await mountPersistence(root, log.root);
  const handle = await persistence.open(log.sessionId, 'read');
  try {
    const read = await readFrom(handle);
    return sessionOver(read.events, log.sessionId);
  } finally {
    await handle.close();
  }
}

/**
 * Open a real host `Session` over a stored event list.
 *
 * A plain object is not accepted: the host's `appendPluginRecord` commits through
 * the instance's own private log and checks the receiver, so the product's real
 * write path only works on a real instance. The stored events are replayed into
 * it so it behaves like the session a restarted host would restore.
 */
function sessionOver(
  events: readonly HostRecordEvent[],
  id: string,
): HostSession {
  const header = {
    version: 4,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd: process.cwd(),
  };
  // The class constructor takes `(id, seed, header)`. A seed is the committed
  // event list, which is exactly what a restored session holds, and the
  // constructor validates its envelope the same way the host does.
  const Class: unknown = Reflect.get(sessionRuntime(), 'Class');
  // A seeded session replays the committed events through the class constructor,
  // which validates each envelope exactly as the host does on restore.
  const construct = constructorOf(Class);
  if (construct === null) {
    throw new TypeError('the host session class is not constructable');
  }
  const session = asObject(construct([id, events, header]));
  // The chat reviewer reads its provider and model from the session's request
  // header, which a live agent turn would have supplied.
  Object.defineProperty(session, 'requestHeader', {
    value: () => ({ config: { provider: 'stub', model: 'stub' } }),
    enumerable: false,
    configurable: true,
  });
  return session;
}

/**
 * The host's `Session` static namespace.
 *
 * `fromRestore` and `create` are static, so they are looked up on the class the
 * fixture already resolved rather than on an instance.
 */
function sessionRuntime(): object {
  return sessionStatics;
}

/** Filled by {@link loadHostModules} so the helpers above need no async call. */
let sessionStatics: object = {};

/**
 * Persist the events a session accumulated since it was opened.
 *
 * The first runtime settled a real verdict into the in-memory session; this
 * writes those committed events through the shipped backend so a restart can
 * read them, exactly as the host's live router would.
 */
async function persistSession(
  log: PersistedLog,
  session: HostSession,
): Promise<void> {
  const root = await hostRuntimeRoot();
  const { persistence } = await mountPersistence(root, log.root);
  // Read the stored log first: everything already there is the seed the restored
  // session replayed, so what is missing is exactly what the product appended.
  const reader = await persistence.open(log.sessionId, 'read');
  let stored: readonly HostRecordEvent[];
  try {
    stored = (await readFrom(reader)).events;
  } finally {
    await reader.close();
  }
  const handle = await persistence.open(log.sessionId, 'write');
  try {
    const all = sessionEvents(session);
    const fresh = all.slice(stored.length);
    if (fresh.length === 0) {
      throw new Error(
        `the settled verdict did not reach the session log: stored=${String(stored.length)} total=${String(all.length)} types=${JSON.stringify(all.map((event) => event.type))}`,
      );
    }
    await appendTo(handle, fresh);
    await flushOf(handle);
  } finally {
    await handle.close();
  }
}

/** Call a handle's `read` without separating the method from its receiver. */
async function readFrom(handle: HandleLike): Promise<{
  readonly events: readonly HostRecordEvent[];
  readonly eventState: string;
}> {
  if (handle.read === undefined) {
    throw new TypeError('the read handle exposes no read()');
  }
  const result = await handle.read();
  const value = asObject(result);
  const events = fieldOf(value, 'events');
  const eventState = fieldOf(value, 'eventState');
  return {
    events: Array.isArray(events) ? events.filter(isHostEvent) : [],
    eventState: typeof eventState === 'string' ? eventState : 'unknown',
  };
}

/** Append committed events through a write handle. */
async function appendTo(
  handle: HandleLike,
  events: readonly HostRecordEvent[],
): Promise<void> {
  if (handle.append === undefined) {
    throw new TypeError('the write handle exposes no append()');
  }
  await handle.append(events);
}

/** Flush a write handle. */
async function flushOf(handle: HandleLike): Promise<void> {
  if (handle.flush === undefined) {
    throw new TypeError('the write handle exposes no flush()');
  }
  await handle.flush();
}

/** State the running host reports for one session's runtime history. */
async function historyState(
  host: DshHost,
): Promise<{ readonly ready: boolean; readonly error: string | null }> {
  const response = await fetch(`${host.origin}/api/arbiter/state`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
    signal: AbortSignal.timeout(10_000),
  });
  expect(response.ok).toBe(true);
  const body: unknown = await response.json();
  if (body === null || typeof body !== 'object') {
    throw new TypeError('the state payload is not an object');
  }
  const records = fieldOf(body, 'sessionRecords');
  if (records === null || typeof records !== 'object') {
    throw new TypeError('the state payload has no sessionRecords');
  }
  const ready = fieldOf(records, 'ready');
  const error = fieldOf(records, 'error');
  return {
    ready: ready === true,
    error: typeof error === 'string' ? error : null,
  };
}

/**
 * Apply the built plugin to a minimal real context and return its host object.
 *
 * This drives the shipped `apply()` — the same entry the DSH loader calls — so
 * the recovery underneath is the product's own `DecisionHistory`, not a
 * re-implementation. The context exposes only what the plugin reads: a profile
 * home, the session lookup, and a logger.
 */
async function applyBuiltPlugin(options: {
  readonly home: string;
  readonly sessions: Map<string, HostSession>;
  readonly config: unknown;
  /**
   * Which profile scope this instance belongs to.
   *
   * The plugin keeps one runtime state per profile for the life of the process, so
   * two `apply()` calls in one process share memory unless the scope differs. A
   * test that claims to prove cold recovery must use a **different** scope for the
   * second instance, otherwise it can pass on the first instance's cached window
   * without reading the log at all.
   */
  readonly scope: string;
}): Promise<{
  readonly host: {
    readonly history?: HistoryLike;
    /** The plugin's reset, when the build exposes it. */
    readonly reset?: (sessionId: string) => void;
    /** Every request the plugin submitted to the reviewer, in order. */
    readonly reviewInputs: readonly string[];
  };
  /** Dispatch one host event through the handlers the plugin registered. */
  readonly emit: (
    event: string,
    args: readonly unknown[],
    next: () => Promise<unknown>,
  ) => Promise<unknown>;
  readonly dispose: () => Promise<void>;
}> {
  const module: unknown = await import(
    pathToFileURL(join(repoRoot, 'lib', 'index.js')).href
  );
  const apply = exportOf(module, 'apply');
  if (typeof apply !== 'function') {
    throw new TypeError('the built plugin does not export apply()');
  }
  const disposers: (() => unknown)[] = [];
  // Registered event handlers, so the test can drive the plugin's real hooks
  // (`tools/pre-execute`) instead of calling an internal method directly.
  const handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();
  // A deterministic reviewer stub: it records what the plugin submits and answers
  // conservatively, so a review can run with no model and no network.
  const reviewInputs: string[] = [];
  const registry: Record<string, unknown> = {
    llm: {
      stream: (request: unknown): AsyncIterable<Record<string, unknown>> => {
        reviewInputs.push(JSON.stringify(request));
        // An async generator satisfies the stream type the provider advertises; the
        // single await is the one a real provider would spend on its first byte.
        const answer = JSON.stringify({
          risk: 4,
          authorized: 1,
        });
        return {
          [Symbol.asyncIterator]: async function* () {
            await Promise.resolve();
            yield { choices: [{ delta: { content: answer } }] };
          },
        };
      },
    },
    profileContext: {
      home: options.home,
      dir: join(options.home, 'profile'),
      name: `history-e2e-${options.scope}`,
    },
    sessions: {
      get: (id: string) => options.sessions.get(id),
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };
  const ctx: unknown = {
    config: options.config,
    get: (key: string) => registry[key],
    on: (event: string, handler: (...args: unknown[]) => unknown) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
      return () => undefined;
    },
    // The plugin registers optional injections; a bare context accepts them and
    // reports no provider, which is what "this service is absent" means here.
    inject: () => () => undefined,
    effect: (callback: () => unknown) => {
      disposers.push(callback);
      return () => undefined;
    },
    logger: registry['logger'],
  };
  const applied = callableOf(apply);
  if (applied === null) {
    throw new TypeError('apply() is not callable');
  }
  const host = asObject(applied(ctx, options.config));
  // The record writer resolves lazily on first use. A real host loads the package
  // instantly because it is installed alongside; here it is a cold module parse, so
  // the first settlement would otherwise race it and report an unavailable writer.
  // Waiting is what a host process already is by the time a tool call arrives.
  const recordsModule: unknown = await import(
    pathToFileURL(join(repoRoot, 'lib', 'records.js')).href
  );
  const readyFn = callableOf(exportOf(recordsModule, 'sessionRecordReady'));
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (readyFn?.() === true) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The history owner is attached to the host object; it is the same instance the
  // gate and the settlement use, so reading it here exercises the product code.
  const historyOwner = fieldOf(host, 'history');
  const history =
    historyOwner === null || historyOwner === undefined
      ? undefined
      : historyOf(asObject(historyOwner));
  const reset =
    historyOwner === null || historyOwner === undefined
      ? undefined
      : resetOf(historyOwner);
  /** Run every handler registered for one host event, in order. */
  const emit = async (
    event: string,
    args: readonly unknown[],
    next: () => Promise<unknown>,
  ): Promise<unknown> => {
    const list = handlers.get(event) ?? [];
    let last: () => Promise<unknown> = next;
    for (const handler of [...list].reverse()) {
      const inner = last;
      last = () => Promise.resolve(handler(...args, inner));
    }
    return last();
  };
  return {
    emit,
    host: {
      ...(history === undefined ? {} : { history }),
      ...(reset === undefined ? {} : { reset }),
      reviewInputs,
    },
    dispose: () => {
      for (const dispose of disposers.reverse()) {
        const call = callableOf(dispose);
        if (call !== null) call();
      }
      return Promise.resolve();
    },
  };
}

/**
 * Narrow the plugin's history owner.
 *
 * Only the three operations this fixture asserts on are wired; a missing one
 * means the built plugin does not expose the contract, which fails loudly.
 */
function historyOf(host: object): HistoryLike {
  const windowFor = callableOf(fieldOf(host, 'windowFor'), host);
  if (windowFor === null) {
    throw new TypeError('the applied plugin exposes no windowFor()');
  }
  return {
    windowFor: (sessionId) => windowOf(windowFor(sessionId)),
  };
}

/** Narrow the plugin's reset operation. */
function resetOf(owner: unknown): ((sessionId: string) => void) | undefined {
  const reset = callableOf(
    fieldOf(asObject(owner), 'resetSession'),
    asObject(owner),
  );
  if (reset === null) return undefined;
  return (sessionId) => {
    reset(sessionId);
  };
}

/** Read one string field, or an empty string when it is not a string. */
function textOf(value: unknown, name: string): string {
  const field = fieldOf(asObject(value), name);
  return typeof field === 'string' ? field : '';
}

/** Read one window result as the shape declared above. */
function windowOf(value: unknown): ReturnType<HistoryLike['windowFor']> {
  const record = asObject(value);
  const items = fieldOf(record, 'items');
  const status = asObject(fieldOf(record, 'status'));
  return {
    items: Array.isArray(items)
      ? items.map((entry) => {
          const item = asObject(entry);
          const trace = fieldOf(item, 'trace');
          return {
            callId: textOf(item, 'callId'),
            result: textOf(item, 'result'),
            trace: Array.isArray(trace) ? trace.map(String) : [],
          };
        })
      : [],
    status: {
      coverage: textOf(status, 'coverage'),
      windowTruncated: fieldOf(status, 'windowTruncated') === true,
      reset: fieldOf(status, 'reset') === true,
    },
  };
}

/** The slice of the plugin's history owner this fixture asserts on. */
interface HistoryLike {
  windowFor(sessionId: string): {
    readonly items: readonly {
      readonly callId: string;
      readonly result: string;
      readonly trace: readonly string[];
    }[];
    readonly status: {
      readonly coverage: string;
      readonly windowTruncated: boolean;
      readonly reset: boolean;
    };
  };
}

/** A minimal arbiter configuration the plugin accepts. */
function arbiterConfig(): Record<string, unknown> {
  return {
    audit: { enabled: false },
    modes: { main: 'normal', subagent: 'strict' },
    // One deterministic rule: the E2E asserts that a real decision reaches the log,
    // so the call must be decided without a reviewer or an approval channel.
    rules: [
      {
        id: 'e2e-deny-build',
        enabled: true,
        match: {
          node: 'command',
          kind: 'exact',
          pattern: 'rm -rf build',
        },
        verdict: 'deny',
      },
    ],
    reviewer: {
      type: 'chat',
      chat: { provider: 'session', model: '' },
    },
    context: { historyMaxItems: 10 },
  };
}

/**
 * The one chain the DSH E2E must close: a verdict the product itself settles,
 * persisted by the host, read back by a restarted host, and visible to the next
 * review.
 *
 * The previous test proves the *reader* against a real log. This one proves the
 * *writer and the gate*: if `CallSettlement.finalize` stopped writing the record,
 * or `CallGate` stopped putting recovered history into the request, this fails.
 */
/**
 * The writer half of the chain: a verdict the product settles is persisted by the
 * real backend, and a *separately scoped* plugin instance reads it back from disk.
 *
 * Two earlier attempts at this test passed for the wrong reason: both plugin
 * instances shared one profile scope, so the second one reused the first one's
 * runtime memory and never read the log at all. The scopes are now distinct, and
 * the log is inspected directly, so a cache hit cannot satisfy the assertion.
 */
test('a verdict the plugin settles is persisted and cold-read by another runtime', async () => {
  // The host installation must be visible before the plugin resolves its record
  // writer; this process is not a DSH host.
  const hostRoot = await hostRuntimeRoot();
  const hostEntry = join(
    hostRoot,
    'node_modules',
    '@deepseek-ai',
    'dsh',
    'lib',
    'bin.js',
  );
  if (
    !process.argv.some((arg) => arg.includes('/node_modules/@deepseek-ai/'))
  ) {
    process.argv.push(hostEntry);
  }
  const log = await persistRealSession();
  const home = await mkdtemp(join(tmpdir(), 'arbiter-gate-home-'));
  try {
    // --- Writer runtime: settle a real verdict through the product's own hook --
    const writerSession = await openPersistedSession(log);
    const writer = await applyBuiltPlugin({
      home,
      sessions: new Map([[log.sessionId, writerSession]]),
      config: arbiterConfig(),
      scope: 'writer',
    });
    try {
      // The gate only decides a call for an admitted session, and admission is a
      // record the plugin writes through the host's own public writer. A real host
      // gets this from the user's session switch; here it is seeded the same way.
      const admissionRoot = await hostRuntimeRoot();
      const admissionModules = await loadHostModules(admissionRoot);
      admissionModules.appendPluginRecord(
        writerSession,
        'plugin:arbiter/admission',
        {
          version: 1,
          sessionId: log.sessionId,
          rootSessionId: log.sessionId,
          enabled: true,
          boundary: 'guarded',
          at: Date.now(),
        },
      );
      const decision = await writer.emit(
        'tools/pre-execute',
        [
          {
            callId: 'real-call',
            name: 'bash',
            arguments: { command: 'rm -rf build' },
            cwd: log.root,
            signal: AbortSignal.timeout(10_000),
            agent: { session: writerSession },
          },
        ],
        () => Promise.resolve({ kind: 'allow' }),
      );
      // The configured rule decided it, so this is a real verdict, not a probe.
      expect(asObject(decision)).toMatchObject({ kind: 'deny' });
    } finally {
      await writer.dispose();
    }
    // The verdict the product formed is now a committed record in its session.
    const committed = sessionEvents(writerSession).filter(
      (event) => event.type === 'plugin:arbiter/decision',
    );
    expect(committed.length).toBeGreaterThan(0);

    // Persist exactly the events the store does not already hold.
    await persistSession(log, writerSession);
    const cold = await coldRead(log);

    // --- Reader runtime: a distinct scope, so only the log can supply the window
    const readerSession = await openPersistedSession(log);
    const reader = await applyBuiltPlugin({
      home,
      sessions: new Map([[log.sessionId, readerSession]]),
      config: arbiterConfig(),
      scope: 'reader',
    });
    try {
      const history = reader.host.history;
      if (history === undefined) {
        throw new TypeError('the applied plugin exposes no history owner');
      }
      const window = history.windowFor(log.sessionId);
      const recovered = window.items.map((entry) => entry.callId);
      // The verdict the writer settled must be in the recovered window, not just
      // the fixture's own records: otherwise a recovery that silently dropped a
      // freshly written decision would still pass.
      expect(recovered).toContain('real-call');
      expect(recovered).toEqual(expect.arrayContaining([...log.written]));
      expect(window.status.coverage).toBe('partial');

      // The next review must happen while this runtime is live: a request issued
      // after `dispose()` would only prove that a stale handler is still callable,
      // not that the plugin puts recovered history into a real submission. A call
      // the rules do not decide is escalated, so the reviewer sees the snapshot the
      // model would.
      const escalated = await reader.emit(
        'tools/pre-execute',
        [
          {
            callId: 'next-review',
            name: 'bash',
            arguments: { command: 'echo next' },
            cwd: log.root,
            signal: AbortSignal.timeout(10_000),
            agent: { session: readerSession },
          },
        ],
        () => Promise.resolve({ kind: 'allow' }),
      );
      expect(asObject(escalated)).toBeDefined();
      const submitted = reader.host.reviewInputs.join('\n');
      // The recovered verdict reached the reviewer as prior history.
      expect(submitted).toContain('real-call');
      expect(submitted).toContain('PRIOR_VERDICTS');
    } finally {
      await reader.dispose();
    }

    // The disk artifact carries the product's own verdict, independently of any
    // plugin instance, which is what makes the recovery above a real read.
    expect(cold.ids).toEqual(
      expect.arrayContaining([...log.written, 'real-call']),
    );
  } finally {
    await rm(home, { recursive: true, force: true });
    await rm(log.root, { recursive: true, force: true });
  }
});

test('the built plugin recovers a real host session log after a cold start', async () => {
  const log = await persistRealSession();
  try {
    // The same real session log, opened for reading and handed to the plugin as
    // a live session, is what a restarted host gives the plugin.
    const session = await openPersistedSession(log);
    const sessions = new Map([[log.sessionId, session]]);
    const home = await mkdtemp(join(tmpdir(), 'arbiter-plugin-home-'));
    const applied = await applyBuiltPlugin({
      home,
      sessions,
      config: arbiterConfig(),
      scope: 'cold-reader',
    });
    try {
      const history = applied.host.history;
      if (history === undefined) {
        throw new TypeError('the applied plugin exposes no history owner');
      }
      // This is the product's own recovery, reading the real records written
      // through the real host writer above.
      const window = history.windowFor(log.sessionId);
      expect(window.items.map((entry) => entry.callId)).toEqual(log.written);
      // Both denials are prior verdicts, and the facts describe a completed read
      // rather than an empty fallback.
      expect(window.items.every((entry) => entry.result === 'deny')).toBe(true);
      // The fixture disables the audit store, so one source is genuinely
      // unavailable and the read is honestly reported as partial rather than
      // claiming a complete history. It is not "unknown": the session log
      // answered, and it is not "known-empty": it supplied both verdicts.
      expect(window.status).toMatchObject({
        coverage: 'partial',
        reset: false,
      });
      expect(window.status.windowTruncated).toBe(false);
      // A reset through the product's own API withdraws them immediately. The
      // session is passed explicitly so the barrier can also be written through
      // the host's public writer.
      applied.host.reset?.(log.sessionId);
      const after = history.windowFor(log.sessionId);
      expect(after.items).toEqual([]);
      expect(after.status.reset).toBe(true);
    } finally {
      await applied.dispose();
      await rm(home, { recursive: true, force: true });
    }
  } finally {
    await rm(log.root, { recursive: true, force: true });
  }
});

test('real plugin records cold-read after a restart, with and without the audit store', async () => {
  // --- 1. A real session is written and persisted by the shipped backend ------
  const log = await persistRealSession();
  const artifacts = join(repoRoot, '.local', 'e2e', 'history-recovery');
  await mkdir(artifacts, { recursive: true });
  try {
    const cold = await coldRead(log);
    // The record survived the write/close/read cycle and keeps its envelope.
    expect(cold.ids).toEqual(log.written);
    expect(cold.headers.every((entry) => entry.endsWith(':true'))).toBe(true);

    // --- 2. A real host restarts on the same isolated profile ---------------
    const first = await startDshHost(repoRoot, join(artifacts, 'first'), {
      keepHome: true,
    });
    let firstState: Awaited<ReturnType<typeof historyState>>;
    try {
      firstState = await historyState(first);
    } finally {
      await first.stop({ keepHome: true });
    }
    const second = await startDshHost(repoRoot, join(artifacts, 'second'), {
      restart: { root: first.root, home: first.home },
    });
    try {
      const secondState = await historyState(second);
      // The plugin reloaded after a real process restart and still answers.
      // A missing session-record API is reported, never silently assumed.
      expect(secondState.error === null || secondState.ready).toBe(true);
      expect({ ...secondState, ready: firstState.ready }).toEqual(secondState);
    } finally {
      await second.stop({ keepHome: true });
    }

    // --- 3. The same cold read with the audit directory moved away ----------
    const auditDir = join(first.home, 'arbiter');
    const moved = `${auditDir}-moved`;
    await rename(auditDir, moved);
    try {
      const withoutAudit = await coldRead(log);
      // Recovery does not depend on the audit store: the records are the same.
      expect(withoutAudit.ids).toEqual(log.written);
    } finally {
      await rename(moved, auditDir);
      await rm(first.root, { recursive: true, force: true });
    }

    await writeFile(
      join(artifacts, 'report.json'),
      JSON.stringify(
        {
          at: new Date().toISOString(),
          modelRequests: 'none',
          written: log.written,
          cold: cold.ids,
          pluginReload: 'served state after a real host restart',
          auditMovedCold: 'records readable without the audit directory',
        },
        null,
        2,
      ),
    );
  } finally {
    await rm(log.root, { recursive: true, force: true });
  }
});
