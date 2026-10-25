/**
 * Read-only, capability-based detection of other approval providers.
 *
 * Two rules shape this module:
 *   - the official Auto Review plugin is the only provider this plugin names.
 *     It is not a blacklist: it is the product it replaces, so its presence is
 *     a fact the coexistence contract asks for;
 *   - every other plugin is judged by observable capability — a registered
 *     `tools/pre-execute` or `approval/request` listener plus declared
 *     approval-related injection — never by package name. A plugin that only
 *     narrows execution (a host guard, a sandbox check) is recorded as an
 *     observation, not as an approval conflict.
 *
 * Everything here is a structural read of public service surfaces (the Loader
 * entry tree, the event bus' listener records, the permission-preset catalog).
 * When a surface is missing the answer is `partial`, never "no conflict".
 */

/** The approval provider this plugin takes over from. */
export const OFFICIAL_AUTO_REVIEW_MODULE =
  '@deepseek-ai/dsh-experimental-auto-review';

/**
 * The vendor scope of the host's own shipped packages.
 *
 * This is provenance, not a plugin list: a listener that comes from a
 * first-party host package is host behaviour (an execution constraint the
 * contract says to keep working), while a listener from any other package is a
 * candidate competing approval provider. No individual third-party package is
 * ever named.
 */
const HOST_VENDOR_SCOPE = '@deepseek-ai/';

/** Whether a module is host-shipped rather than installed alongside it. */
function isHostModule(moduleName: string | null): boolean {
  return moduleName !== null && moduleName.startsWith(HOST_VENDOR_SCOPE);
}

/**
 * Events whose listeners can change whether a tool call proceeds or is asked
 * about. A host guard is not a listener: `tools.guard()` registers in a separate
 * monotonic list, so it never appears here and is never mistaken for a provider.
 */
export const APPROVAL_EVENTS = [
  'tools/pre-execute',
  'approval/request',
] as const;

export type ApprovalEvent = (typeof APPROVAL_EVENTS)[number];

/** A fiber lifecycle phase, spelled the way the host's inventory spells it. */
export type FiberPhase =
  | 'pending'
  | 'loading'
  | 'active'
  | 'failed'
  | 'unloading'
  | 'disposed'
  | 'unknown';

/** The permission-preset Auto slot, as far as this plugin can prove it. */
export type AutoSlot = 'arbiter' | 'other' | 'unknown';

export interface ProviderEntry {
  readonly entryId: string | null;
  readonly moduleName: string | null;
  readonly enabled: boolean;
  readonly phase: FiberPhase;
  readonly injects: readonly string[];
}

export interface ObservedHook {
  readonly event: ApprovalEvent;
  readonly entryId: string | null;
  readonly moduleName: string | null;
  readonly prepend: boolean;
  readonly global: boolean;
  /**
   * Services the owning fiber declared.
   *
   * Supporting detail only: a listener on a decision event is already capable of
   * changing the outcome, whether or not it also injects the approval service.
   */
  readonly injects: readonly string[];
}

/** What the host services exposed for one read. */
export interface CoexistenceObservation {
  readonly entries: readonly ProviderEntry[];
  readonly hooks: readonly ObservedHook[];
  /** Public surfaces that could not be read; every one is reported. */
  readonly missing: readonly string[];
  readonly autoSlot: AutoSlot;
  readonly autoError: string | null;
}

export interface OfficialProvider {
  readonly present: boolean;
  readonly module: string;
  readonly enabled: boolean;
  readonly running: boolean;
  readonly phase: FiberPhase | null;
}

export type ConflictKind =
  'official-auto-review' | 'auto-slot' | 'approval-hook';

export interface CoexistenceConflict {
  /** Stable identity for one continuous conflict period. */
  readonly id: string;
  readonly severity: 'blocking' | 'warning';
  readonly kind: ConflictKind;
  /** Module, entry or synthetic slot name; never an invented plugin list. */
  readonly source: string;
  readonly entryId: string | null;
  readonly capability: string;
  readonly detail: string | null;
}

export interface CoexistenceAssessment {
  readonly detection: 'complete' | 'partial';
  readonly missing: readonly string[];
  readonly blocked: boolean;
  readonly conflicts: readonly CoexistenceConflict[];
  readonly official: OfficialProvider;
  readonly autoSlot: AutoSlot;
  readonly observedHooks: readonly ObservedHook[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function stringsOf(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

/**
 * Read one plugin's declared injection.
 *
 * `options.inject` is the profile's declaration and `fiber.inject` the resolved
 * dependency map; either alone can be absent, so both are merged. Names are the
 * only capability signal available for a plugin this runtime did not write.
 */
function injectsOf(entry: Record<string, unknown>): readonly string[] {
  const names = new Set<string>();
  const options = entry['options'];
  if (isRecord(options)) {
    for (const name of stringsOf(options['inject'])) names.add(name);
    const nested = options['inject'];
    if (isRecord(nested))
      for (const name of Object.keys(nested)) names.add(name);
  }
  const fiber = entry['fiber'];
  if (isRecord(fiber)) {
    const resolved = fiber['inject'];
    if (isRecord(resolved)) {
      for (const name of Object.keys(resolved)) names.add(name);
    }
  }
  return [...names].sort();
}

const PHASES: Readonly<Record<number, FiberPhase>> = {
  0: 'pending',
  1: 'loading',
  2: 'active',
  3: 'failed',
  4: 'disposed',
  5: 'unloading',
};

function phaseOf(entry: Record<string, unknown>): FiberPhase {
  const fiber = entry['fiber'];
  if (!isRecord(fiber)) return 'unknown';
  const state = fiber['state'];
  if (typeof state !== 'number') return 'unknown';
  return PHASES[state] ?? 'unknown';
}

function entryIdOf(entry: Record<string, unknown>): string | null {
  const id = entry['id'];
  return typeof id === 'string' ? id : null;
}

function moduleOf(entry: Record<string, unknown>): string | null {
  const options = entry['options'];
  if (!isRecord(options)) return null;
  const name = options['name'];
  return typeof name === 'string' ? name : null;
}

/** Bound every structural walk so a hostile or huge tree cannot stall a gate. */
const MAX_ITEMS = 512;

/**
 * Visit the items of an array, iterable or generator result.
 *
 * Cordis' `entries()` returns a generator, so the value is walked through the
 * `Symbol.iterator` protocol instead of being asserted into a container type.
 * Returns false when the value is not iterable at all.
 */
export function eachItem(
  value: unknown,
  visit: (item: unknown, index: number) => void,
): boolean {
  if (Array.isArray(value)) {
    value.slice(0, MAX_ITEMS).forEach(visit);
    return true;
  }
  if (!isRecord(value) && typeof value !== 'object') return false;
  if (value === null) return false;
  const factory: unknown = Reflect.get(value, Symbol.iterator);
  if (typeof factory !== 'function') return false;
  const iterator: unknown = Reflect.apply(factory, value, []);
  if (!isRecord(iterator)) return false;
  const next: unknown = iterator['next'];
  if (typeof next !== 'function') return false;
  for (let index = 0; index < MAX_ITEMS; index += 1) {
    const step: unknown = Reflect.apply(next, iterator, []);
    if (!isRecord(step) || step['done'] === true) return true;
    visit(step['value'], index);
  }
  return true;
}

interface ReadInput {
  readonly loader: unknown;
  readonly events: unknown;
  /** The running plugin's own fiber, to exclude its own listeners. */
  readonly selfFiber: unknown;
  readonly autoSlot: AutoSlot;
  readonly autoError: string | null;
}

function readEntries(loader: unknown): {
  readonly entries: readonly ProviderEntry[];
  readonly missing: boolean;
} {
  if (!isRecord(loader)) return { entries: [], missing: true };
  const entriesOf = loader['entries'];
  if (typeof entriesOf !== 'function') return { entries: [], missing: true };
  const listed: unknown = Reflect.apply(entriesOf, loader, []);
  const entries: ProviderEntry[] = [];
  if (
    !eachItem(listed, (item) => {
      if (!isRecord(item)) return;
      // Group nodes are declarations, not running plugins.
      const options = item['options'];
      if (isRecord(options) && options['group']) return;
      entries.push({
        entryId: entryIdOf(item),
        moduleName: moduleOf(item),
        enabled: !(isRecord(options) && options['disabled'] === true),
        phase: phaseOf(item),
        injects: injectsOf(item),
      });
    })
  )
    return { entries: [], missing: true };
  return { entries, missing: false };
}

function selfFiberOf(hook: Record<string, unknown>): unknown {
  const owner = hook['ctx'];
  return isRecord(owner) ? owner['fiber'] : undefined;
}

function hookOwner(hook: Record<string, unknown>): {
  entryId: string | null;
  moduleName: string | null;
} {
  const owner = hook['ctx'];
  if (!isRecord(owner)) return { entryId: null, moduleName: null };
  const fiber = owner['fiber'];
  if (!isRecord(fiber)) return { entryId: null, moduleName: null };
  const entry = fiber['entry'];
  if (!isRecord(entry)) return { entryId: null, moduleName: null };
  return { entryId: entryIdOf(entry), moduleName: moduleOf(entry) };
}

function injectsOfOwner(hook: Record<string, unknown>): readonly string[] {
  const owner = hook['ctx'];
  if (!isRecord(owner)) return [];
  const fiber = owner['fiber'];
  if (!isRecord(fiber)) return [];
  const inject = fiber['inject'];
  return isRecord(inject) ? Object.keys(inject).sort() : [];
}

function readHooks(
  events: unknown,
  selfFiber: unknown,
): {
  readonly hooks: readonly ObservedHook[];
  readonly missing: boolean;
} {
  if (!isRecord(events)) return { hooks: [], missing: true };
  const registry = events['_hooks'];
  if (!isRecord(registry)) return { hooks: [], missing: true };
  const hooks: ObservedHook[] = [];
  for (const event of APPROVAL_EVENTS) {
    const list = registry[event];
    if (list === undefined) continue;
    eachItem(list, (item) => {
      if (!isRecord(item)) return;
      // This plugin's own listener is the gate, not a competing provider.
      if (selfFiberOf(item) === selfFiber && selfFiber !== undefined) return;
      const owner = hookOwner(item);
      hooks.push({
        event,
        entryId: owner.entryId,
        moduleName: owner.moduleName,
        prepend: item['prepend'] === true,
        global: item['global'] === true,
        injects: injectsOfOwner(item),
      });
    });
  }
  return { hooks, missing: false };
}

/** Read every public surface this runtime can see, reporting what was absent. */
export function readObservation(input: ReadInput): CoexistenceObservation {
  const { entries, missing: entriesMissing } = readEntries(input.loader);
  const { hooks, missing: hooksMissing } = readHooks(
    input.events,
    input.selfFiber,
  );
  const missing: string[] = [];
  if (entriesMissing) missing.push('loader');
  if (hooksMissing) missing.push('events');
  return {
    entries,
    hooks,
    missing,
    autoSlot: input.autoSlot,
    autoError: input.autoError,
  };
}

function sourceOf(value: {
  entryId: string | null;
  moduleName: string | null;
}): string {
  return value.moduleName ?? value.entryId ?? 'unknown';
}

/**
 * Turn one observation into the current conflict set.
 *
 * Blocking is reserved for the official provider actually running. Everything
 * else is a warning: a saved configuration, a failed load, another listener
 * with approval capability, or the Auto slot being held elsewhere.
 */
function hooksOf(observation: CoexistenceObservation): readonly ObservedHook[] {
  return observation.hooks;
}

/**
 * One conflict per distinct capability owner.
 *
 * The event name is part of the identity: a plugin that both reviews before
 * execution and answers approval requests is two observable capabilities, and a
 * second listener on the same event from the same owner is still one row.
 */
/** What can be said about one listener without inventing a provider identity. */
function hookDetail(hook: ObservedHook): string | null {
  const facts: string[] = [];
  if (hook.prepend) facts.push('prepend');
  if (hook.global) facts.push('global');
  const services = hook.injects.filter(
    (name) => name === 'approval' || name === 'permissionPresets',
  );
  if (services.length > 0) facts.push(services.join(','));
  return facts.length === 0 ? null : facts.join(' ');
}

function hookConflicts(hooks: readonly ObservedHook[]): CoexistenceConflict[] {
  const seen = new Set<string>();
  const conflicts: CoexistenceConflict[] = [];
  for (const hook of hooks) {
    // The official provider already has its own blocking row; repeating it as a
    // generic listener would report one fact twice, at two severities.
    if (hook.moduleName === OFFICIAL_AUTO_REVIEW_MODULE) continue;
    // A host-shipped listener is the host's own execution constraint, which the
    // contract keeps working. Only a listener from outside that composition is a
    // candidate competing provider.
    if (isHostModule(hook.moduleName)) continue;
    const key = `${hook.entryId ?? hook.moduleName ?? 'unknown'}:${hook.event}`;
    if (seen.has(key)) continue;
    seen.add(key);
    conflicts.push({
      id: `hook:${key}`,
      severity: 'warning',
      kind: 'approval-hook',
      source: sourceOf(hook),
      entryId: hook.entryId,
      capability: hook.event,
      detail: hookDetail(hook),
    });
  }
  return conflicts;
}

export function assess(
  observation: CoexistenceObservation,
): CoexistenceAssessment {
  const officialEntry = observation.entries.find(
    (entry) => entry.moduleName === OFFICIAL_AUTO_REVIEW_MODULE,
  );
  const official: OfficialProvider = {
    present: officialEntry !== undefined,
    module: OFFICIAL_AUTO_REVIEW_MODULE,
    enabled: officialEntry?.enabled ?? false,
    // The live fiber state is authoritative: a saved enable flag is
    // configuration, and the contract forbids concluding "already stopped" from
    // it. `enabled` is reported as supporting metadata only.
    running: officialEntry?.phase === 'active',
    phase: officialEntry?.phase ?? null,
  };
  const conflicts: CoexistenceConflict[] = [];
  if (official.running) {
    conflicts.push({
      id: 'official-auto-review',
      severity: 'blocking',
      kind: 'official-auto-review',
      source: official.module,
      entryId: officialEntry?.entryId ?? null,
      capability: 'permissionPresets.auto',
      detail: null,
    });
  }
  if (observation.autoSlot === 'other') {
    conflicts.push({
      id: 'auto-slot',
      severity: 'warning',
      kind: 'auto-slot',
      source: 'auto',
      entryId: null,
      capability: 'permissionPresets.auto',
      detail: observation.autoError,
    });
  }
  conflicts.push(...hookConflicts(hooksOf(observation)));
  return {
    detection: observation.missing.length === 0 ? 'complete' : 'partial',
    missing: observation.missing,
    blocked: conflicts.some((conflict) => conflict.severity === 'blocking'),
    conflicts,
    official,
    autoSlot: observation.autoSlot,
    observedHooks: observation.hooks,
  };
}

/** The locator the client and the admission API report for a block. */
export function blockReasonOf(
  assessment: CoexistenceAssessment,
): 'official-running' | null {
  return assessment.blocked ? 'official-running' : null;
}
