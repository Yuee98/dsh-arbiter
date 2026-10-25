import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'vitest';

import { apply } from '../../src/index.js';
import {
  COMMON_GUIDANCE,
  PARENT_GUIDANCE,
  SUBAGENT_GUIDANCE,
  guidanceRegistration,
} from '../../src/host/guidance.js';
import { installSessionRecordApi } from '../../src/records.js';
import type {
  AssembleContextLike,
  ConnectionLike,
  ContextLike,
  HostServices,
  ProfileContextLike,
  PromptContextRegistrationLike,
} from '../../src/host/types.js';
import type { AgentLike, SessionEventLike } from '../../src/snapshot.js';
import {
  admitSession,
  recordingSessionApi,
} from '../helpers/session-records.js';

/**
 * Standing agent guidance through the real plugin entry point.
 *
 * The contract is the host's public system-context hook, not a string builder: a
 * composition with the prompt registry receives one required context
 * registration, the hook decides its text per assembly from the
 * backend-confirmed admission, and disposing the plugin releases the
 * registration. Nothing here asserts that some prose was concatenated.
 */

const homes: string[] = [];
let previousHome: string | undefined;

beforeAll(() => {
  installSessionRecordApi(recordingSessionApi());
});

afterAll(() => {
  installSessionRecordApi(null);
});

beforeEach(async () => {
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-guidance-'));
  homes.push(home);
  process.env['DSH_HOME'] = home;
});

afterEach(async () => {
  if (previousHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = previousHome;
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
});

interface StubSession {
  readonly id: string;
  readonly header: {
    readonly id: string;
    readonly cwd: string;
    readonly parentSession?: string;
    readonly origin?: string;
  };
  readonly events: SessionEventLike[];
  readonly append: (type: string, data: unknown) => void;
  readonly snapshotEvents: () => readonly SessionEventLike[];
}

function makeSession(
  id: string,
  options: { readonly parentSession?: string } = {},
): StubSession {
  const events: SessionEventLike[] = [];
  return {
    id,
    header: {
      id,
      cwd: process.cwd(),
      ...(options.parentSession === undefined
        ? {}
        : { parentSession: options.parentSession, origin: 'subagent' }),
    },
    events,
    append(type, data) {
      events.push({
        type,
        seq: events.length,
        data,
        ignorable: type.startsWith('plugin:'),
      });
    },
    snapshotEvents: () => events,
  };
}

/** One registration the host registry actually holds. */
interface Held {
  readonly registration: PromptContextRegistrationLike;
  live: boolean;
}

interface PromptStub {
  readonly held: readonly Held[];
  /** The text the host would place in the runtime context for one assembly. */
  readonly textFor: (agent: AgentLike | undefined) => string;
}

interface Harness {
  readonly prompt: PromptStub;
  readonly dispose: () => void;
  /** Re-apply the plugin against the same live sessions (cold restore). */
  readonly reread: (config: unknown) => Harness;
}

function createHarness(
  sessions: readonly StubSession[],
  config: unknown,
  options: {
    readonly withPrompt?: boolean;
    /** Whether the host ever resolves the injected service graph. */
    readonly injectRuns?: boolean;
  } = {},
): Harness {
  const held: Held[] = [];
  const disposers: (() => unknown)[] = [];
  const home = process.env['DSH_HOME'] ?? '';
  const withPrompt = options.withPrompt ?? true;
  const injectRuns = options.injectRuns ?? true;

  const prompt = {
    context(registration: PromptContextRegistrationLike): () => void {
      const entry: Held = { registration, live: true };
      held.push(entry);
      return () => {
        entry.live = false;
      };
    },
    getContextOrder(name: string): number {
      // The host's own placement table; the plugin only reads its order.
      return name === 'APPROVAL_POLICY' ? 115 : Number.NaN;
    },
  };

  interface Services extends Partial<Omit<HostServices, 'presets'>> {
    readonly profileContext?: ProfileContextLike;
    readonly sandboxPolicy?: { readonly defaultMode?: string };
    readonly connection?: ConnectionLike;
    readonly permissionPresets?: HostServices['presets'];
    readonly systemPrompt?: unknown;
  }

  const services: Services = {
    profileContext: { home, dir: home, name: 'guidance-test' },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    ...(withPrompt ? { systemPrompt: prompt } : {}),
    sessions: {
      get: (id) => sessions.find((session) => session.id === id),
      list: () => [...sessions],
    },
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve('unavailable'),
    },
    permissionPresets: { registerAuto: () => () => {} },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
    connection: {
      fetch: {
        register: () => () => undefined,
      },
    },
  };

  function get(key: 'profileContext'): Services['profileContext'];
  function get(key: 'sandboxPolicy'): Services['sandboxPolicy'];
  function get(key: 'sessions'): Services['sessions'];
  function get(key: 'llm'): Services['llm'];
  function get(key: 'approval'): Services['approval'];
  function get(key: 'permissionPresets'): Services['permissionPresets'];
  function get(key: 'workingDirectory'): Services['workingDirectory'];
  function get(key: 'credentials'): Services['credentials'];
  function get(key: 'configEditor'): Services['configEditor'];
  function get(key: 'commands'): Services['commands'];
  function get(key: 'connection'): Services['connection'];
  function get(key: 'systemPrompt'): Services['systemPrompt'];
  function get(key: string): unknown;
  function get(key: string): unknown {
    return Reflect.get(services, key);
  }

  const ctx: ContextLike = {
    get,
    on() {
      return () => undefined;
    },
    effect(fn) {
      const dispose: unknown = fn();
      if (typeof dispose === 'function')
        disposers.push(() => Reflect.apply(dispose, undefined, []));
      return undefined;
    },
    // The stub has no service graph; the callback receives the same context,
    // which is where the host would supply the injected service. A composition
    // that never provides the service never runs the callback at all.
    inject(
      _names: readonly string[],
      callback: (child: ContextLike) => unknown,
    ) {
      return injectRuns ? callback(ctx) : undefined;
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    },
  };

  apply(ctx, config);

  const harness: Harness = {
    prompt: {
      held,
      textFor: (agent) => {
        const entry = held.find((candidate) => candidate.live);
        if (entry === undefined) return '';
        const { registration } = entry;
        if (typeof registration.text !== 'function')
          throw new TypeError('guidance must decide its text per assembly');
        const assembled: AssembleContextLike =
          agent === undefined ? {} : { agent };
        return registration.text(assembled);
      },
    },
    dispose: () => {
      for (const dispose of disposers.splice(0)) dispose();
    },
    reread: (nextConfig) => {
      harness.dispose();
      return createHarness(sessions, nextConfig);
    },
  };
  return harness;
}

const ENABLED = { enabled: true };

function agentFor(session: StubSession): AgentLike {
  return { session };
}

describe('agent guidance hook', () => {
  test('registers one runtime-context contribution with the host', () => {
    const session = makeSession('g-main');
    const harness = createHarness([session], ENABLED);
    try {
      expect(harness.prompt.held).toHaveLength(1);
      const [entry] = harness.prompt.held;
      expect(entry?.live).toBe(true);
      expect(entry?.registration.name).toBe('arbiter:agent-guidance');
      // Static prose: the host must not interpolate anything into it, so a
      // stray `{{...}}` in guidance can never fail an assembly.
      expect(entry?.registration.interpolate).toBe(false);
      // Right after the host's own approval-policy line.
      expect(entry?.registration.order).toBe(116);
      // A required context survives a complete persona and the suppression of
      // optional runtime context.
      expect(entry?.registration.required).toBe(true);
    } finally {
      harness.dispose();
    }
  });

  test('disposing the plugin releases the registration', () => {
    const session = makeSession('g-release');
    const harness = createHarness([session], ENABLED);
    const entry = harness.prompt.held[0];
    expect(entry?.live).toBe(true);
    harness.dispose();
    expect(entry?.live).toBe(false);
    expect(harness.prompt.textFor(agentFor(session))).toBe('');
  });

  test('an admitted main session receives the parent guidance', () => {
    const session = makeSession('g-admitted-main');
    const harness = createHarness([session], ENABLED);
    try {
      // Before any admission the host must contribute nothing at all.
      expect(harness.prompt.textFor(agentFor(session))).toBe('');
      admitSession(session);
      expect(harness.prompt.textFor(agentFor(session))).toBe(PARENT_GUIDANCE);
    } finally {
      harness.dispose();
    }
  });

  test('an admitted subagent receives the reporting guidance', () => {
    const parent = makeSession('g-parent');
    const child = makeSession('g-child', { parentSession: 'g-parent' });
    const harness = createHarness([parent, child], ENABLED);
    try {
      admitSession(parent);
      // The child inherits the parent's admission exactly as the gate does.
      expect(harness.prompt.textFor(agentFor(child))).toBe(SUBAGENT_GUIDANCE);
      // And the parent that carries the record keeps the parent guidance.
      expect(harness.prompt.textFor(agentFor(parent))).toBe(PARENT_GUIDANCE);
      // Both roles carry the shared non-execution semantics, not only their
      // role-specific paragraph.
      expect(harness.prompt.textFor(agentFor(parent))).toContain(
        COMMON_GUIDANCE,
      );
      expect(harness.prompt.textFor(agentFor(child))).toContain(
        COMMON_GUIDANCE,
      );
    } finally {
      harness.dispose();
    }
  });

  test('an unenabled session is never injected, including its children', () => {
    const parent = makeSession('g-plain-parent');
    const child = makeSession('g-plain-child', {
      parentSession: 'g-plain-parent',
    });
    const harness = createHarness([parent, child], ENABLED);
    try {
      expect(harness.prompt.textFor(agentFor(parent))).toBe('');
      expect(harness.prompt.textFor(agentFor(child))).toBe('');
    } finally {
      harness.dispose();
    }
  });

  test('an explicitly disabled session stops receiving guidance', () => {
    const session = makeSession('g-disabled');
    const harness = createHarness([session], ENABLED);
    try {
      admitSession(session);
      expect(harness.prompt.textFor(agentFor(session))).toBe(PARENT_GUIDANCE);
      admitSession(session, { enabled: false });
      expect(harness.prompt.textFor(agentFor(session))).toBe('');
    } finally {
      harness.dispose();
    }
  });

  test('a disabled plugin contributes nothing even to an admitted session', () => {
    const session = makeSession('g-plugin-off');
    const harness = createHarness([session], { enabled: false });
    try {
      admitSession(session);
      expect(harness.prompt.textFor(agentFor(session))).toBe('');
    } finally {
      harness.dispose();
    }
  });

  test('an assembly without an agent contributes nothing', () => {
    const session = makeSession('g-no-agent');
    const harness = createHarness([session], ENABLED);
    try {
      admitSession(session);
      expect(harness.prompt.textFor(undefined)).toBe('');
    } finally {
      harness.dispose();
    }
  });

  test('a cold restore reads admission from the session log, not memory', () => {
    const session = makeSession('g-restored');
    admitSession(session);
    // First runtime never saw the switch happen; the second one folds it from
    // the same committed log.
    const first = createHarness([session], ENABLED);
    const reopened = first.reread(ENABLED);
    try {
      expect(reopened.prompt.textFor(agentFor(session))).toBe(PARENT_GUIDANCE);
    } finally {
      reopened.dispose();
    }
  });

  test('the exported registration keeps guidance required and literal', () => {
    const registration = guidanceRegistration(116, () => PARENT_GUIDANCE);
    expect(registration.name).toBe('arbiter:agent-guidance');
    expect(registration.order).toBe(116);
    expect(registration.interpolate).toBe(false);
    // The host must keep this context even when a complete persona replaced
    // every section and optional runtime context is suppressed.
    expect(registration.required).toBe(true);
    expect(typeof registration.text).toBe('function');
  });

  test('a composition without the prompt service still applies', () => {
    const session = makeSession('g-no-service');
    const harness = createHarness([session], ENABLED, { withPrompt: false });
    try {
      // The plugin must not fail to load just because this host composes no
      // prompt registry; there is simply nothing for it to contribute.
      expect(harness.prompt.held).toHaveLength(0);
      expect(harness.prompt.textFor(agentFor(session))).toBe('');
    } finally {
      harness.dispose();
    }
  });
});
