/**
 * The host client services the permission selector needs, behind one adapter.
 *
 * The arbiter browser bundle declares only `slots` and `locale`. The selector
 * additionally needs the host's permission surfaces, but declaring them as
 * dependencies would park the whole plugin — including its settings page — in a
 * composition with no host permission UI. They are therefore read through
 * `ctx.get` and exposed as one narrow, optional bridge: absent services degrade
 * the control and never break the plugin.
 *
 * Only documented public surfaces are used:
 *   - `sessions.binding(id).session.command()` for the native switch,
 *   - the session's own `permissions` projection for the *current* preset,
 *   - `remote.permissionPresets.catalog()` for the selectable presets,
 *   - the session event window, the connection generation, the catalog event and
 *     the permission projection for invalidation.
 *
 * Nothing here computes admission state, and no preset is derived from a
 * sandbox value: a host value that happens to equal the guarded bundle says
 * nothing about whether Arbiter is enabled.
 */

import type {
  HostBridge,
  HostPermissionCatalogOption,
  HostPresetSelection,
} from './view-types.js';

/** The subset of an observable snapshot the bridge reads. */
interface ObservableLike {
  getSnapshot(): unknown;
  subscribe(listener: () => void): () => void;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === 'object';
}

function observableOf(value: unknown): ObservableLike | null {
  if (!isRecord(value)) return null;
  const getSnapshot = value['getSnapshot'];
  const subscribe = value['subscribe'];
  if (typeof getSnapshot !== 'function' || typeof subscribe !== 'function')
    return null;
  return {
    getSnapshot: () => {
      const snapshot: unknown = Reflect.apply(getSnapshot, value, []);
      return snapshot;
    },
    subscribe: (listener) => {
      const stop: unknown = Reflect.apply(subscribe, value, [listener]);
      if (typeof stop !== 'function') return () => undefined;
      return () => {
        Reflect.apply(stop, value, []);
      };
    },
  };
}

/** One catalog option the host advertised, or `null` when malformed. */
function optionOf(value: unknown): HostPermissionCatalogOption | null {
  if (!isRecord(value)) return null;
  const id = value['value'];
  const name = value['name'];
  if (typeof id !== 'string' || typeof name !== 'string') return null;
  const description = value['description'];
  return {
    value: id,
    name,
    ...(typeof description === 'string' ? { description } : {}),
  };
}

function catalogOf(value: unknown): readonly HostPermissionCatalogOption[] {
  if (!isRecord(value)) return [];
  // The Remote call answers `{ok, value}`; the catalog itself is the payload.
  const payload = value['ok'] === true ? value['value'] : value;
  if (!isRecord(payload)) return [];
  const options = payload['options'];
  if (!Array.isArray(options)) return [];
  return options.flatMap((entry) => {
    const option = optionOf(entry);
    return option === null ? [] : [option];
  });
}

/** The bound session's public face, or `null` while not materialized. */
function sessionOf(
  sessions: Readonly<Record<string, unknown>>,
  id: string,
): Readonly<Record<string, unknown>> | null {
  const binding = sessions['binding'];
  if (typeof binding !== 'function') return null;
  const bound = Reflect.apply(binding, sessions, [id]) as unknown;
  if (!isRecord(bound)) return null;
  const session = bound['session'];
  return isRecord(session) ? session : null;
}

/** The session's `permissions` projection value, unparsed. */
function currentPresetOf(
  session: Readonly<Record<string, unknown>>,
): string | null {
  const projections = session['projections'];
  if (!isRecord(projections)) return null;
  const faceOf = projections['faceOf'];
  if (typeof faceOf !== 'function') return null;
  const face = observableOf(
    Reflect.apply(faceOf, projections, ['permissions']),
  );
  if (face === null) return null;
  const value = face.getSnapshot();
  if (!isRecord(value)) return null;
  const current = value['currentValue'];
  return typeof current === 'string' ? current : null;
}

/** The catalog reader, or `null` when this composition has no presets. */
function catalogReader(
  presets: Readonly<Record<string, unknown>>,
): (() => Promise<unknown>) | null {
  const catalog = presets['catalog'];
  if (typeof catalog !== 'function') return null;
  return () => Promise.resolve(Reflect.apply(catalog, presets, []) as unknown);
}

/** Whether a host command result proves the command ran and matched. */
function commandMatched(result: unknown): boolean {
  if (!isRecord(result) || result['ok'] === false) return false;
  const value = result['value'];
  return isRecord(value) && value['matched'] === true;
}

/**
 * Build the selector's host adapter from the plugin context.
 *
 * Services are resolved per call, never captured once: a composition can
 * provide `sessions`/`remote` after this plugin starts, and a cached
 * `undefined` would disable the selector for the page's whole lifetime.
 */
export function createHostBridge(get: (name: string) => unknown): HostBridge {
  const sessions = (): Readonly<Record<string, unknown>> | null => {
    const value = get('sessions');
    return isRecord(value) ? value : null;
  };
  return {
    available() {
      const service = sessions();
      return service !== null && typeof service['binding'] === 'function';
    },
    hostPreset(sessionId) {
      const service = sessions();
      if (service === null) return null;
      const session = sessionOf(service, sessionId);
      return session === null ? null : selectionOf(session);
    },
    async catalog() {
      // Generated Remote namespaces are cordis services in their own right:
      // `remote.permissionPresets`, not a member of the `remote` object.
      const presets = get('remote.permissionPresets');
      if (!isRecord(presets)) return null;
      const read = catalogReader(presets);
      if (read === null) return null;
      try {
        return catalogOf(await read());
      } catch {
        // A failed catalog read is "unavailable", never "no host presets".
        return null;
      }
    },
    async selectPreset(sessionId, preset) {
      const service = sessions();
      if (service === null) return false;
      const session = sessionOf(service, sessionId);
      if (session === null) return false;
      const command = session['command'];
      if (typeof command !== 'function') return false;
      try {
        const result = await Promise.resolve(
          Reflect.apply(command, session, [`/permission ${preset}`]) as unknown,
        );
        return commandMatched(result);
      } catch {
        return false;
      }
    },
    observe(sessionId, listener) {
      return observeAll(get, sessionId, listener);
    },
  };
}

/** The host's current preset for one materialized session. */
function selectionOf(
  session: Readonly<Record<string, unknown>>,
): HostPresetSelection | null {
  const currentValue = currentPresetOf(session);
  return currentValue === null ? null : { currentValue };
}

/**
 * Subscribe to every host signal that may change the shown state.
 *
 * Four sources, all invalidation-only:
 *   - the bound session's own event window, filtered to a settled
 *     `/permission` command (covers a same-value exit whose knobs never change),
 *   - the connection generation (a silent reconnect after a dropped socket),
 *   - `permission-presets/catalog-changed` (an option set that moved),
 *   - the session's `permissions` projection face (a value change).
 *
 * The returned disposer releases all of them.
 */
function observeAll(
  get: (name: string) => unknown,
  sessionId: string,
  listener: () => void,
): () => void {
  const stops: (() => void)[] = [];
  const service = get('sessions');
  if (isRecord(service) && typeof service['binding'] === 'function') {
    const session = sessionOf(service, sessionId);
    if (session !== null) {
      stops.push(observeEvents(session, listener));
      stops.push(observeProjection(session, listener));
      stops.push(observeGeneration(session, listener));
    }
  }
  const remote = get('remote');
  if (isRecord(remote) && typeof remote['$on'] === 'function') {
    const on = remote['$on'];
    const stop: unknown = Reflect.apply(on, remote, [
      'permission-presets/catalog-changed',
      listener,
    ]);
    if (typeof stop === 'function') {
      stops.push(() => {
        Reflect.apply(stop, remote, []);
      });
    }
  }
  return () => {
    for (const stop of stops) stop();
  };
}

/**
 * Fires when a `/permission` command settles, including a same-value one.
 *
 * `command/done` carries no command name — only `commandId`, `kind` and an
 * optional `text` — so the two events are correlated by `commandId`: a
 * `command/run` with `name: 'permission'` is remembered until its own
 * `command/done`. A same-value `/permission workspace-write` writes no permission
 * event at all, so this settlement is the only signal that the backend may have
 * exited admission.
 */
function observeEvents(
  session: Readonly<Record<string, unknown>>,
  listener: () => void,
): () => void {
  const source = observableOf(session['eventSource']);
  if (source === null) return () => undefined;
  const permissionCommands = new Set<string>();
  let last = '';
  return source.subscribe(() => {
    const window = source.getSnapshot();
    if (!isRecord(window)) return;
    const entries = window['entries'];
    if (!Array.isArray(entries)) return;
    const signature = JSON.stringify(entries.at(-1) ?? null);
    if (signature === last) return;
    last = signature;
    if (advanceCommands(entries, permissionCommands)) listener();
  });
}

/**
 * Track `/permission` command pairs and report whether one settled.
 *
 * Every command/run and command/done in the newest window is inspected, so a
 * burst that arrives in one frame is not missed.
 */
function advanceCommands(
  entries: readonly unknown[],
  permissionCommands: Set<string>,
): boolean {
  let settled = false;
  for (const entry of entries.slice(-8)) {
    if (!isRecord(entry)) continue;
    const event = entry['event'];
    if (!isRecord(event)) continue;
    const data = event['data'];
    if (!isRecord(data)) continue;
    const commandId = data['commandId'];
    if (typeof commandId !== 'string') continue;
    if (event['type'] === 'command/run') {
      // The name only exists on command/run; command/done is correlated by id.
      if (data['name'] === 'permission') permissionCommands.add(commandId);
      continue;
    }
    if (event['type'] !== 'command/done') continue;
    if (permissionCommands.delete(commandId)) settled = true;
  }
  return settled;
}

/** The permission projection face; a value change is an invalidation. */
function observeProjection(
  session: Readonly<Record<string, unknown>>,
  listener: () => void,
): () => void {
  const projections = session['projections'];
  if (!isRecord(projections)) return () => undefined;
  const faceOf = projections['faceOf'];
  if (typeof faceOf !== 'function') return () => undefined;
  const face = observableOf(
    Reflect.apply(faceOf, projections, ['permissions']),
  );
  return face === null ? () => undefined : face.subscribe(listener);
}

/** The session's connection generation; a silent reconnect is an invalidation. */
function observeGeneration(
  session: Readonly<Record<string, unknown>>,
  listener: () => void,
): () => void {
  const connection = session['connection'];
  if (!isRecord(connection)) return () => undefined;
  const generation = observableOf(connection['generation']);
  return generation === null ? () => undefined : generation.subscribe(listener);
}
