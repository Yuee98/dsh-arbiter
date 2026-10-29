/**
 * Runtime history and cold recovery, driven through the real plugin.
 *
 * What is pinned here, and why each matters:
 *   - memory, the session log and SQLite select the same verdicts, so a restart
 *     cannot change what counts as history;
 *   - scope is this session only, so a sibling's verdict is never borrowed;
 *   - the window, its ordering and its identity are the same everywhere, so a
 *     recovered window is the window memory would have held;
 *   - a recovered chain is completed from the newer real stage without inventing
 *     one, and a disagreement is reported instead of resolved;
 *   - every failure shape (audit moved, records missing, both missing, partial
 *     clear, capacity change, explicit reset, write failure) has a determinate,
 *     distinguishable outcome that never fabricates a human rejection.
 *
 * The plugin runs for real (`apply`), SQLite is a real `AuditStore`, and the
 * session objects are real `Session` instances from the pinned host runtime when
 * it is resolvable; otherwise an in-memory stub with the same event surface is
 * used, so the suite runs on a checkout without a DSH installation.
 */

import { mkdtemp, rm } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { AuditStore } from '../../src/audit.js';
import type { CallRecord } from '../../src/audit.js';
import { apply } from '../../src/index.js';
import {
  installSessionRecordApi,
  sessionRecordError,
  sessionRecordReady,
} from '../../src/records.js';
import {
  admitSession,
  recordingSessionApi,
} from '../helpers/session-records.js';

import type {
  ConnectionLike,
  ContextLike,
  HostServices,
  ProfileContextLike,
  ToolExecutionLike,
} from '../../src/host/types.js';
import type { PriorVerdictItem } from '../../src/types.js';

const homes: string[] = [];
/** One writer double for the whole suite; the installer refuses a second one. */
const sharedRecordApi = recordingSessionApi();
const profileRoots: string[] = [];
let previousHome: string | undefined;
let instances = 0;

beforeEach(async () => {
  // One isolated home per test: the audit database and the profile scope both
  // live under it, so no test can observe another test's rows or runtime.
  previousHome = process.env['DSH_HOME'];
  const home = await mkdtemp(join(tmpdir(), 'arbiter-history-'));
  homes.push(home);
  process.env['DSH_HOME'] = home;
  instances = 0;
});

afterEach(async () => {
  // Drop the writer between cases so a later test installs its own double; the
  // production installer refuses to swap one live API for another.
  installSessionRecordApi(null);
  if (previousHome === undefined) delete process.env['DSH_HOME'];
  else process.env['DSH_HOME'] = previousHome;
  for (const home of homes.splice(0)) {
    await rm(home, { recursive: true, force: true });
  }
  for (const root of profileRoots.splice(0)) {
    await rm(root, { recursive: true, force: true });
  }
});

interface StubEvent {
  readonly type: string;
  readonly seq: number;
  readonly time?: number;
  readonly data?: unknown;
  readonly ignorable?: boolean;
}

interface TestSession {
  readonly id: string;
  readonly header: { readonly id: string; readonly cwd: string };
  snapshotEvents(): readonly StubEvent[];
  append(type: string, data: unknown): unknown;
  /**
   * A complete request header.
   *
   * The chat reviewer reads its provider/model from the session, and a session
   * outside a live agent turn has none. Supplying one keeps the review path
   * exercised without pretending to be a model configuration.
   */
  requestHeader(): {
    readonly config: { readonly provider: string; readonly model: string };
  };
}

/** The provider/model a live agent turn would have selected. */
function requestHeaderOf(): {
  readonly config: { readonly provider: string; readonly model: string };
} {
  return { config: { provider: 'stub', model: 'stub' } };
}

/** An in-memory session with the host's committed-event envelope. */
function stubSession(id: string, events: StubEvent[]): TestSession {
  let index = events.length;
  return {
    id,
    header: { id, cwd: process.cwd() },
    snapshotEvents: () => [...events],
    requestHeader: requestHeaderOf,
    append(type: string, data: unknown) {
      if (data === undefined || typeof data !== 'object') {
        throw new Error('session event data must be a JSON object');
      }
      // Ordinary host events keep their envelope but are not ignorable records;
      // only `plugin:` types are written the way `appendPluginRecord` writes.
      const isRecordType = type.startsWith('plugin:');
      events.push({
        type,
        seq: index,
        time: Date.now(),
        data: JSON.parse(JSON.stringify(data)) as unknown,
        ...(isRecordType ? { ignorable: true } : {}),
      });
      index += 1;
      return index;
    },
  };
}

/** A session whose log refuses to be read, for the unreadable-source case. */
function unreadableSession(id: string): TestSession {
  return {
    id,
    header: { id, cwd: process.cwd() },
    snapshotEvents() {
      throw new Error('the session log could not be read');
    },
    append() {
      throw new Error('the session log could not be written');
    },
    requestHeader: requestHeaderOf,
  };
}

function makeSession(
  id: string,
  events: StubEvent[] = [],
  options: { readonly unreadable?: boolean } = {},
): TestSession {
  return options.unreadable === true
    ? unreadableSession(id)
    : stubSession(id, events);
}

const recordApiReady = (): boolean => sessionRecordReady();

/**
 * Wait for the plugin's record resolver to settle.
 *
 * The runtime loads the session package after `apply`, so a call issued in the
 * same tick would observe the pre-load state. Waiting here keeps the write path
 * under test rather than racing its own initialization.
 */
async function settleRecords(): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (sessionRecordReady() || sessionRecordError() !== null) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Append one decision record in the exact envelope the host writes.
 *
 * `appendPluginRecord` adds `ignorable: true` and the payload snapshot; this
 * helper produces the same committed event so a test can prepare a session log
 * without a DSH installation. When the real writer is resolvable the tests use
 * it instead and assert the envelope matches.
 */
function seedDecision(
  session: TestSession,
  payload: Record<string, unknown>,
  time: number,
): void {
  const events = session.snapshotEvents();
  const seq = events.length;
  // `snapshotEvents` returns a copy, so the array is mutated through the
  // session's own append hook to keep the stub's index in step.
  session.append('plugin:arbiter/decision', payload);
  const written = session.snapshotEvents().at(-1);
  if (written === undefined || written.seq !== seq) {
    throw new Error('the seeded record did not receive the next sequence');
  }
  // The host stamps `time`; a fixed value keeps ordering assertions exact.
  Object.defineProperty(written, 'time', {
    value: time,
    enumerable: true,
    configurable: true,
  });
}

/** Host-shaped tool execution passed to the registered gate. */
function exec(
  session: TestSession,
  callId: string,
  tool = 'bash',
  args: unknown = { command: 'rm -rf build' },
): ToolExecutionLike {
  return {
    callId,
    name: tool,
    arguments: args,
    signal: new AbortController().signal,
    agent: { session },
  };
}

/* -------------------------------------------------------------------- host */

type Gate = (
  exec: ToolExecutionLike,
  next: () => Promise<{ kind: string }>,
) => Promise<{ kind: string }>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

interface HostHarness {
  readonly ctx: ContextLike;
  readonly gate: () => Gate;
  readonly sessions: Map<string, TestSession>;
  /** The most recent review request the stub model received. */
  readonly captured: string[];
  /** Perform the plugin's own explicit runtime-history reset for one session. */
  readonly reset: (session: TestSession) => void;
  /** The runtime's own prior-verdict window, independent of what a review shows. */
  readonly window: (sessionId: string) => readonly PriorVerdictItem[];
  /** Whether the runtime reports this session's history as explicitly reset. */
  readonly windowReset: (sessionId: string) => boolean;
  /** Clear a session's record-failure fact, as a successful write would. */
  readonly recordSucceeded: (sessionId: string) => void;
  /** The history status the runtime currently reports for one session. */
  readonly resetStatus: (sessionId: string) => {
    readonly coverage: string;
    readonly reset: boolean;
    readonly reason: string | null;
  };
  readonly dispose: () => Promise<void>;
}

/**
 * One plugin instance on a stub context.
 *
 * The model is a stub: this suite is about which verdicts enter the review
 * input, not about model quality. Every call therefore uses a deterministic rule
 * verdict, so a test controls the recorded result exactly.
 */
async function harness(options: {
  readonly sessions: Map<string, TestSession>;
  readonly config?: (base: Readonly<Record<string, unknown>>) => unknown;
  readonly approval?: 'unavailable' | 'allowed-once' | 'rejected';
  readonly auditEnabled?: boolean;
  /** Leave the audit store out entirely, as a disabled or failed store would. */
  readonly auditDisabled?: boolean;
  /**
   * Do not install the recording record writer.
   *
   * The gate admits a session through the plugin's own admission record, so a
   * managed call needs a writer. Cases about a *failing* writer deliberately leave
   * this off, which is what makes the settlement take its failure branch.
   */
  readonly noRecordApi?: boolean;
  /** The session the gate should decide for; admitted when a writer is installed. */
  readonly admitted?: TestSession;
  /** Admit every session in the map, for cases that drive more than one. */
  readonly admittedAll?: boolean;
  /** Continue when the session log cannot even be written (unreadable-log cases). */
  readonly tolerateAdmissionFailure?: boolean;
  /**
   * Which runtime this instance attaches to.
   *
   * The plugin keeps one runtime state per profile for the life of the process,
   * so a plugin reload reuses it — that is what preserves memory across a
   * reload. Every harness therefore gets its own profile by default; a test that
   * wants to simulate a host restart after a real one gets a second, distinct
   * profile and can then assert what a cold read recovers.
   */
  readonly profile?: string;
}): Promise<HostHarness> {
  const captured: string[] = [];
  const disposers: (() => unknown)[] = [];
  let gate: Gate | undefined;
  const home = process.env['DSH_HOME'] ?? tmpdir();
  const auditErrorCapture: string[] = [];
  const registry: Record<string, unknown> = {
    profileContext: {
      home,
      dir: join(home, `profile-${options.profile ?? String((instances += 1))}`),
      name: 'history-test',
    },
    sandboxPolicy: { defaultMode: 'workspace-write' },
    sessions: {
      get: (id: string) => options.sessions.get(id),
    },
    llm: {
      stream: (request: {
        readonly messages: readonly {
          readonly content: readonly { readonly text?: string }[];
        }[];
      }): AsyncIterable<Record<string, unknown>> => {
        const text = request.messages[0]?.content[0]?.text ?? '';
        captured.push(text);
        // A valid answer keeps every call on the normal review path with a
        // deterministic result, so the suite never reaches a model. A probe is
        // answered permissively so the probe itself is allowed and therefore
        // never becomes a prior verdict: the window under test then holds only
        // the decisions the test deliberately created.
        const isProbe = text.includes('echo probe');
        const answer = JSON.stringify({
          risk: 4,
          authorization: isProbe ? 10 : 1,
        });
        return (async function* () {
          await Promise.resolve();
          yield { type: 'text-delta', text: answer };
          yield { type: 'finish', reason: { kind: 'stop' } };
        })();
      },
    },
    approval: {
      config: { policy: 'ask' },
      request: () => Promise.resolve(options.approval ?? 'unavailable'),
    },
    permissionPresets: { registerAuto: () => () => undefined },
    workingDirectory: { ensure: () => Promise.resolve(process.cwd()) },
  };
  function get(key: 'profileContext'): ProfileContextLike | undefined;
  function get(
    key: 'sandboxPolicy',
  ): { readonly defaultMode?: string } | undefined;
  function get(key: 'sessions'): HostServices['sessions'];
  function get(key: 'llm'): HostServices['llm'];
  function get(key: 'approval'): HostServices['approval'];
  function get(key: 'permissionPresets'): HostServices['presets'];
  function get(key: 'workingDirectory'): HostServices['workingDirectory'];
  function get(key: 'credentials'): HostServices['credentials'];
  function get(key: 'configEditor'): HostServices['configEditor'];
  function get(key: 'commands'): HostServices['commands'];
  function get(key: 'connection'): ConnectionLike | undefined;
  function get(key: string): unknown;
  function get(key: string): unknown {
    return registry[key];
  }
  type Listener = (...args: never[]) => unknown;
  const ctx: ContextLike = {
    get,
    on(event: string, listener: Listener) {
      if (event !== 'tools/pre-execute') return () => undefined;
      gate = async (execution, next) => {
        const decision: unknown = await Reflect.apply(listener, undefined, [
          execution,
          next,
        ]);
        if (!isRecord(decision) || typeof decision['kind'] !== 'string') {
          throw new TypeError('the gate returned an invalid decision');
        }
        return { ...decision, kind: decision['kind'] };
      };
      return () => undefined;
    },
    effect(callback: () => unknown) {
      const dispose: unknown = callback();
      // The disposer is a function from the host's point of view; push a
      // callable wrapper so teardown stays typed without a cast at the call site.
      if (typeof dispose === 'function') {
        disposers.push(() =>
          Promise.resolve(Reflect.apply(dispose, undefined, [])),
        );
      }
      return dispose;
    },
    inject() {
      return undefined;
    },
    logger: {
      info: () => undefined,
      warn: () => undefined,
      error: (...args: unknown[]) => {
        auditErrorCapture.push(args.map((entry) => String(entry)).join(' '));
      },
    },
  };
  const auditEnabled = !options.auditDisabled;
  if (options.noRecordApi !== true) {
    // The gate only decides a call for an admitted session, and admission is
    // written through the plugin's own record writer. Installing the same-contract
    // double is what lets these cases reach the gate at all.
    installSessionRecordApi(sharedRecordApi);
    const sessions = [...options.sessions.values()];
    const admitted = options.admitted ?? sessions[0];
    try {
      if (options.admittedAll === true) {
        for (const session of sessions) admitSession(session);
      } else if (admitted !== undefined) {
        admitSession(admitted);
      }
    } catch (error) {
      // A session whose log cannot be written cannot be admitted either. These
      // cases exercise a read failure, and the gate still has to run so the
      // failure can be observed.
      if (options.tolerateAdmissionFailure !== true) throw error;
    }
  } else {
    installSessionRecordApi(null);
  }
  const applied = apply(
    ctx,
    options.config?.({
      audit: { enabled: auditEnabled },
    }) ?? {
      audit: { enabled: auditEnabled },
    },
  );
  if (auditErrorCapture.length > 0) {
    throw new Error(
      `the plugin logged an error: ${auditErrorCapture.join('; ')}`,
    );
  }
  // The plugin resolves the session record writer right after `apply`; waiting
  // here means every call in this suite goes through the real write path rather
  // than racing its own initialization and silently taking the failure branch.
  await settleRecords();
  return {
    ctx,
    sessions: options.sessions,
    captured,
    /**
     * Perform an explicit runtime-history reset for one session.
     *
     * The plugin's own history object is reached through the runtime it created,
     * so the test drives the real reset rather than a parallel implementation.
     */
    window: (sessionId: string) =>
      applied.history?.windowFor(sessionId).items ?? [],
    windowReset: (sessionId: string) =>
      applied.history?.windowFor(sessionId).status.reset === true,
    recordSucceeded: (sessionId: string) => {
      applied.history?.clearRecordFailure(sessionId);
    },
    resetStatus: (sessionId: string) => {
      const status = applied.history?.windowFor(sessionId).status;
      return {
        coverage: status?.coverage ?? 'unknown',
        reset: status?.reset ?? false,
        reason: status?.reason ?? null,
      };
    },
    reset: (target: TestSession) => {
      // The plugin's own reset, through the host object it wired.
      applied.history?.resetSession(target.id);
    },
    gate: () => {
      if (gate === undefined) throw new Error('the gate was not registered');
      return gate;
    },
    dispose: async () => {
      for (const dispose of disposers.splice(0)) await dispose();
    },
  };
}

/* -------------------------------------------------------------------- audit */

function auditPath(): string {
  return join(process.env['DSH_HOME'] ?? '', 'arbiter', 'arbiter.db');
}

function verdictRecord(
  callId: string,
  ts: number,
  result: CallRecord['result'],
  session = 'session-1',
): CallRecord {
  return {
    callId,
    ts,
    sessionId: session,
    sessionKind: 'main',
    parentSession: null,
    profile: 'history-test',
    workspace: process.cwd(),
    tool: 'bash',
    arguments: { command: 'rm -rf build' },
    cwd: process.cwd(),
    fingerprint: `bash:${callId}`,
    configRevision: 'rev-1',
    configSnapshotId: 'snap-1',
    approvalMode: 'ask',
    executionMode: 'guarded',
    result,
    reason: 'recorded by the audit fixture',
    // The stage chain a real decision produces: the rule stage carries the
    // outcome, and the review stage records how the model answered. A rule denial
    // has no review stage at all, so the fixture mirrors the shape it seeded in
    // the session record rather than inventing a longer chain.
    trace: [{ stage: 'rule', result, at: ts }],
    effect: null,
    sessionRecordState: 'written',
    snapshot: null,
    modelAttempts: [],
    scores: null,
    reviewStage: null,
    usage: null,
    decisionRules: [],
    executionStatus: 'not-started',
  };
}

/**
 * Write audit rows with a store that is then closed, as a real restart would.
 *
 * `enqueue` schedules its write on the next tick, so closing immediately would
 * drop the queue and leave an empty database — which is exactly the failure this
 * suite must not accidentally fake. The writes are awaited before closing.
 */
/**
 * A timestamp the default 30-day retention will keep.
 *
 * `apply()` runs retention on startup, so a fixture stamped in 1970 would be
 * deleted before the test could read it: correct product behaviour, and a
 * fixture that would silently prove nothing.
 */
function recent(offsetMs: number): number {
  return Date.now() - 60_000 + offsetMs;
}

async function seedAudit(records: readonly CallRecord[]): Promise<void> {
  const store = new AuditStore(auditPath(), {
    enabled: true,
    retentionDays: 30,
    retentionBytes: 1024 * 1024 * 1024,
    maxQueue: 500,
  });
  try {
    for (const record of records) store.enqueue(record);
    await settled(store, records.length);
  } finally {
    store.close();
  }
  // The plugin opens the database in WAL mode. A separate connection only sees
  // rows once the WAL is checkpointed into the main file, so the seed makes them
  // durable before another handle opens the database.
  checkpointAudit();
}

/**
 * Fold the audit WAL into the main database file and release the file.
 *
 * The checkpoint must run after the seeding store is closed and must release its
 * own handle, otherwise the plugin's later `AuditStore` open contends with it for
 * the write lock and every read fails as "database is locked".
 */
function checkpointAudit(): void {
  const db = new DatabaseSync(auditPath());
  try {
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    db.exec('PRAGMA journal_mode = DELETE');
  } finally {
    db.close();
  }
}

/**
 * Wait until the audit store reports every queued row written.
 *
 * `enqueue` drains on `setImmediate`, so the count is the real evidence that the
 * rows exist. A dropped row or a write error fails loudly instead of leaving a
 * quietly empty database for the recovery test to mistake for "no history".
 */
async function settled(store: AuditStore, expected: number): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    const health = store.health();
    const stats: unknown = store.stats();
    const total =
      isRecord(stats) && typeof stats['calls'] === 'number'
        ? stats['calls']
        : 0;
    if (health.dropped > 0) {
      throw new Error(`the audit seed dropped rows: ${String(health.dropped)}`);
    }
    if (health.lastError !== null) {
      throw new Error(`the audit seed failed: ${health.lastError}`);
    }
    if (health.pending === 0 && total >= expected) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(
    `the audit seed did not settle: ${JSON.stringify(store.health())}`,
  );
}

/** A command the deny rule cannot match, so the call reaches the reviewer. */
const PROBE_ARGS = { command: 'echo probe' };

/**
 * Run one probe call that produces a review input without being denied.
 *
 * The fixture rule denies only `rm -rf build`; a probe uses a different command
 * so the call reaches the snapshot builder and the submitted history can be
 * read back from the request the reviewer would have received.
 */
const PROBE_PREFIX = 'probe-';

/** Whether the plugin's history currently reports a reset for the session. */
function appliedReset(host: HostHarness): boolean {
  return host.windowReset('session-1');
}

async function probe(host: HostHarness, session: TestSession): Promise<void> {
  await callOnce(
    host,
    session,
    `${PROBE_PREFIX}${String(Date.now())}`,
    'bash',
    PROBE_ARGS,
  );
}

/**
 * The window without the probe's own record.
 *
 * A probe is a real call that is itself a prior verdict for the next review, so
 * history assertions exclude it and keep the expected population explicit.
 */
function windowOf(host: HostHarness): string[] {
  return submittedHistory(host)
    .map((entry) => entry.callId)
    .filter((callId) => !callId.startsWith(PROBE_PREFIX));
}

/** Run one call through the gate and return the decision it produced. */
async function callOnce(
  host: HostHarness,
  session: TestSession,
  callId: string,
  tool = 'bash',
  args: unknown = { command: 'rm -rf build' },
): Promise<{ readonly kind: string }> {
  const decision = await host.gate()(exec(session, callId, tool, args), () =>
    Promise.resolve({ kind: 'allow' }),
  );
  return { kind: decision.kind };
}

/**
 * The prior verdicts in the snapshot the last review actually submitted.
 *
 * `snapshotHistory` renders newest-first for the reviewer, while the runtime
 * window itself is selected oldest-first and then trimmed to the newest N. Both
 * orders are deterministic; the selection is what must not change across a
 * restart.
 */
function submittedHistory(host: HostHarness): PriorVerdictItem[] {
  return submittedHistoryBlock(host).prior;
}

/**
 * The prior-verdict block exactly as the reviewer received it.
 *
 * The submitted text is the only artifact that proves what the review saw; the
 * status helper below reads the same block so a test cannot assert on a value
 * that never reached the model.
 */
function submittedHistoryBlock(host: HostHarness): {
  readonly prior: PriorVerdictItem[];
  readonly truncated: boolean;
  readonly missing: readonly string[];
} {
  const text = host.captured.at(-1);
  if (text === undefined) throw new Error('no review request was captured');
  // Both facts travel in the completeness block the current renderer emits:
  // `missing_input` is the sentence list and `blocking_gaps` the blocking subset.
  const priorMatch = /PRIOR_VERDICTS\n(\{[\s\S]*?\n\})/u.exec(text);
  const completeMatch = /MATERIAL_COMPLETENESS\n[\s\S]*?(\{[\s\S]*?\n\})/u.exec(
    text,
  );
  if (priorMatch?.[1] === undefined || completeMatch?.[1] === undefined) {
    throw new Error('the submitted request has no PRIOR_VERDICTS block');
  }
  const prior: unknown = JSON.parse(priorMatch[1]);
  const complete: unknown = JSON.parse(completeMatch[1]);
  if (!isRecord(prior) || !isRecord(complete)) {
    throw new Error('the submitted blocks are malformed');
  }
  const items = prior['prior_verdicts'];
  if (!Array.isArray(items)) throw new Error('no prior_verdicts array');
  const missing = complete['missing_input'];
  if (!Array.isArray(missing)) throw new Error('no missing_input array');
  return {
    prior: items.filter(
      (entry): entry is PriorVerdictItem =>
        isRecord(entry) && typeof entry['callId'] === 'string',
    ),
    truncated: prior['truncated'] === true,
    missing: missing.filter(
      (entry): entry is string => typeof entry === 'string',
    ),
  };
}

/**
 * A configuration whose deterministic rule denies a specific command.
 *
 * A rule verdict is used throughout so the recorded result is exact and the
 * suite makes no model request.
 */
function denyRuleConfig(
  extra: (base: Record<string, unknown>) => Record<string, unknown> = (base) =>
    base,
): (base: Readonly<Record<string, unknown>>) => unknown {
  return (base) =>
    extra({
      ...base,
      modes: { main: 'ask', subagent: 'no-ask' },
      rules: [
        {
          id: 'deny-build',
          enabled: true,
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'rm -rf build' },
          ],
          verdict: 'deny',
        },
        // A probe is forced through the reviewer without being denied, so it
        // never becomes a prior verdict and a window assertion is about the real
        // denials alone.
        {
          id: 'review-probe',
          enabled: true,
          conditions: [
            { target: 'command', kind: 'exact', pattern: 'echo probe' },
          ],
          verdict: 'force-review',
          hint: 'probe',
        },
      ],
      reviewer: { type: 'chat', chat: { provider: 'session', model: '' } },
    });
}

describe('three sources select the same prior verdicts', () => {
  test('a rule denial recorded by the live path appears identically after recovery', async () => {
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await settleRecords();
      const decision = await callOnce(host, session, 'call-live');
      expect(decision.kind).toBe('deny');
      const records = session
        .snapshotEvents()
        .filter((event) => event.type === 'plugin:arbiter/decision');
      // The record is either written with the host's `ignorable` marker, or it
      // is absent *and* the plugin named the reason. Both are correct per this
      // checkout's capability, and neither is a silent skip. The two shapes are
      // compared in one assertion so the branch is data, not control flow.
      const wrote = recordApiReady();
      expect({
        wrote,
        count: records.length,
        ignorable: wrote ? (records[0]?.ignorable ?? null) : null,
        reported: wrote ? null : sessionRecordError(),
      }).toEqual(
        wrote
          ? { wrote, count: 1, ignorable: true, reported: null }
          : {
              wrote,
              count: 0,
              ignorable: null,
              reported: sessionRecordError(),
            },
      );
      // When the writer is unavailable the reported reason names the package.
      expect(
        wrote || (sessionRecordError() ?? '').includes('dsh-session'),
      ).toBe(true);
      // The runtime window holds the verdict immediately, without waiting for
      // either durable write.
      await probe(host, session);
      expect(windowOf(host)).toEqual(['call-live']);
    } finally {
      await host.dispose();
    }

    // A fresh runtime on the same session and the same audit directory: this is
    // what a host restart leaves behind, and the audit row is the durable source.
    const restarted = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'restarted',
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(restarted, session);
      const history = windowOf(restarted);
      expect(history).toEqual(['call-live']);
      const recovered = submittedHistory(restarted).find(
        (entry) => entry.callId === 'call-live',
      );
      expect(recovered).toMatchObject({ result: 'deny', tool: 'bash' });
      // A rule denial records the rule stage alone, and recovery adds no stage.
      expect(recovered?.trace).toEqual(['deny']);
    } finally {
      await restarted.dispose();
    }
  });

  test('a fallback denial is a prior verdict, and no allow ever is', async () => {
    const session = makeSession('session-1');
    // The durable record of a fallback denial, in the payload the plugin writes.
    seedDecision(
      session,
      {
        version: 2,
        callId: 'call-fallback',
        tool: 'bash',
        fingerprint: 'bash:call-fallback',
        trace: ['review-escalate', 'fallback-deny'],
        result: 'fallback-deny',
        reason: 'approval_unavailable',
        configRevision: 'rev-1',
        ts: recent(0),
      },
      recent(0),
    );
    // An allowed call is never a candidate, whichever source observed it.
    seedDecision(
      session,
      {
        version: 2,
        callId: 'call-allowed',
        tool: 'bash',
        fingerprint: 'bash:call-allowed',
        trace: ['allow'],
        result: 'allow',
        configRevision: 'rev-1',
        ts: recent(1),
      },
      recent(1),
    );
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'recovered-fallback',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const history = windowOf(host);
      expect(history).toEqual(['call-fallback']);
      expect(
        submittedHistory(host).find(
          (entry) => entry.callId === 'call-fallback',
        ),
      ).toMatchObject({ result: 'fallback-deny' });
    } finally {
      await host.dispose();
    }
  });

  test('a sibling subagent verdict never enters this session history', async () => {
    const sibling = makeSession('session-sibling');
    const target = makeSession('session-target');
    const sessions = new Map([
      ['session-sibling', sibling],
      ['session-target', target],
    ]);
    seedDecision(
      sibling,
      {
        version: 2,
        callId: 'sibling-call',
        tool: 'bash',
        fingerprint: 'bash:sibling-call',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: recent(0),
      },
      recent(0),
    );
    await seedAudit([
      verdictRecord('sibling-call', recent(0), 'deny', 'session-sibling'),
    ]);
    const host = await harness({
      sessions,
      profile: 'sibling',
      admitted: target,
      // Both sessions are real callers, so both are admitted; the case is that
      // the target's window still excludes the sibling's verdict.
      admittedAll: true,
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      // The target session has its own empty history, even though a sibling
      // wrote a real denial to the same host.
      await probe(host, target);
      expect(windowOf(host)).toEqual([]);
      // And the sibling's own window still holds it, so the exclusion is scope,
      // not a lost record.
      await probe(host, sibling);
      expect(windowOf(host)).toEqual(['sibling-call']);
    } finally {
      await host.dispose();
    }
  });
});

describe('window, ordering and identity', () => {
  test('the recovered window equals the window memory would have held', async () => {
    const session = makeSession('session-1', []);
    // The breaker is off so a run of denials does not divert the probe to a
    // human channel; this test is about the window, not about circuit breaking.
    const windowConfig = (base: Readonly<Record<string, unknown>>): unknown =>
      denyRuleConfig((inner) => ({
        ...inner,
        context: { historyMaxItems: 10 },
        breaker: { mode: 'off' },
      }))(base);
    const live = await harness({
      sessions: new Map([['session-1', session]]),
      config: windowConfig,
    });
    let inMemory: string[];
    try {
      for (let index = 0; index < 5; index += 1) {
        await callOnce(live, session, `call-${String(index)}`);
      }
      await probe(live, session);
      inMemory = windowOf(live);
      // Newest first, and every real call is present exactly once.
      expect(inMemory).toEqual([
        'call-4',
        'call-3',
        'call-2',
        'call-1',
        'call-0',
      ]);
    } finally {
      await live.dispose();
    }
    // A fresh runtime on the same log and database. Its read is a recovery, and
    // it must select the identical population in the identical order.
    const recovered = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'recovered',
      config: windowConfig,
    });
    try {
      await probe(recovered, session);
      const history = windowOf(recovered);
      // The probe's own record is newest, so the recovered view of the five real
      // calls is exactly the one memory held.
      expect(history).toEqual(inMemory);
      expect(new Set(history).size).toBe(history.length);
    } finally {
      await recovered.dispose();
    }
  });

  test('allows in the tail of a session log cannot starve the denials', async () => {
    const session = makeSession('session-1');
    // The exact shape the window boundary must survive: two denials, then two
    // allows, with a window of two. Trimming before filtering would keep the two
    // allows, filter them to nothing, and report an empty history.
    const base = recent(-40_000);
    const population: readonly (readonly [string, string])[] = [
      ['deny-a', 'deny'],
      ['deny-b', 'deny'],
      ['allow-c', 'allow'],
      ['allow-d', 'review-allow'],
    ];
    for (const [index, [callId, result]] of population.entries()) {
      seedDecision(
        session,
        {
          version: 2,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: [result],
          result,
          configRevision: 'rev-1',
          ts: base + index,
        },
        base + index,
      );
    }
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'allow-tail',
      config: denyRuleConfig((baseConfig) => ({
        ...baseConfig,
        rules: [],
        context: { historyMaxItems: 2 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      // A session-only recovery (no audit rows) still finds both denials.
      expect(windowOf(host)).toEqual(['deny-b', 'deny-a']);
      expect(submittedHistoryBlock(host).missing.join(' ')).not.toContain(
        'could not be recovered',
      );
    } finally {
      await host.dispose();
    }
  });

  test('five distinct denials in a window of two are reported as truncated', async () => {
    const session = makeSession('session-1');
    const base = recent(-50_000);
    // Distinct logical calls, all eligible. The window keeps the newest two and
    // must say it cut three, which a count taken after trimming cannot see.
    for (let index = 0; index < 5; index += 1) {
      const callId = `deny-${String(index)}`;
      seedDecision(
        session,
        {
          version: 2,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: base + index,
        },
        base + index,
      );
    }
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'five-denials',
      config: denyRuleConfig((baseConfig) => ({
        ...baseConfig,
        rules: [],
        context: { historyMaxItems: 2 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      expect(windowOf(host)).toEqual(['deny-4', 'deny-3']);
      // The three dropped calls are a real cut, not a normal full window.
      expect(submittedHistoryBlock(host).truncated).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  test('duplicate records of one call occupy a single slot', async () => {
    const session = makeSession('session-1');
    const base = recent(-30_000);
    // Three observations of two logical calls, one of them repeated at the same
    // instant. The window must count two calls, not three records.
    for (const [index, callId] of ['dup-a', 'dup-a', 'dup-b'].entries()) {
      seedDecision(
        session,
        {
          version: 2,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: base + Math.floor(index / 2),
        },
        base + Math.floor(index / 2),
      );
    }
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'duplicates',
      config: denyRuleConfig((baseConfig) => ({
        ...baseConfig,
        rules: [],
        context: { historyMaxItems: 2 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      const ids = windowOf(host);
      expect(ids).toEqual(['dup-b', 'dup-a']);
      expect(new Set(ids).size).toBe(2);
      // Duplicate records of one call are one logical call, so the window was not
      // cut: claiming truncation here would misreport normal dedup as lost history.
      expect(submittedHistoryBlock(host).truncated).toBe(false);
    } finally {
      await host.dispose();
    }
  });

  test('a window smaller than the population keeps the newest calls in both paths', async () => {
    const session = makeSession('session-1', []);
    const windowConfig = (base: Readonly<Record<string, unknown>>): unknown =>
      denyRuleConfig((inner) => ({
        ...inner,
        context: { historyMaxItems: 3 },
        breaker: { mode: 'off' },
      }))(base);
    const live = await harness({
      sessions: new Map([['session-1', session]]),
      config: windowConfig,
    });
    try {
      for (let index = 0; index < 5; index += 1) {
        await callOnce(live, session, `call-${String(index)}`);
      }
      await probe(live, session);
      // The probe was allowed by the review, so it is not a prior verdict; the
      // three slots hold the three newest denials and the older two are cut.
      expect(windowOf(live)).toEqual(['call-4', 'call-3', 'call-2']);
      expect(submittedHistoryBlock(live).truncated).toBe(true);
    } finally {
      await live.dispose();
    }
    const recovered = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'recovered',
      config: windowConfig,
    });
    try {
      await probe(recovered, session);
      // Recovery applies the same capacity rule to the same population, so the
      // restart does not widen the window back to the older calls.
      expect(windowOf(recovered)).toEqual(['call-4', 'call-3', 'call-2']);
    } finally {
      await recovered.dispose();
    }
  });

  test('audit rows that disagree with the session record are deduplicated by call', async () => {
    const session = makeSession('session-1');
    for (const [index, callId] of ['shared-1', 'shared-2'].entries()) {
      seedDecision(
        session,
        {
          version: 1,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: ['deny'],
          result: 'deny',
          reason: 'session record',
          configRevision: 'rev-1',
          ts: recent(index),
        },
        recent(index),
      );
    }
    // Seed SQLite with the same two calls plus one it alone observed.
    await seedAudit([
      verdictRecord('shared-1', recent(0), 'deny'),
      verdictRecord('shared-2', recent(1), 'deny'),
      verdictRecord('audit-only', recent(2), 'review-deny'),
    ]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
        rules: [],
      })),
    });
    try {
      await probe(host, session);
      const history = windowOf(host);
      // Newest-first for display; three logical calls, not five observations.
      expect(history).toEqual(['audit-only', 'shared-2', 'shared-1']);
      const shared = submittedHistory(host).find(
        (entry) => entry.callId === 'shared-1',
      );
      // The merged entry keeps one conclusion and one slot.
      expect(shared?.result).toBe('deny');
    } finally {
      await host.dispose();
    }
  });

  test('a newer real stage stored in audit completes the recovered chain', async () => {
    const session = makeSession('session-1');
    // The session record lost the last stage (an interrupted write is one way
    // this happens); the audit row still holds the full chain.
    seedDecision(
      session,
      {
        version: 1,
        callId: 'partial-chain',
        tool: 'bash',
        fingerprint: 'bash:partial-chain',
        trace: ['rule'],
        result: 'human-deny',
        configRevision: 'rev-1',
        ts: recent(10),
      },
      recent(10),
    );
    const record = verdictRecord('partial-chain', recent(10), 'human-deny');
    // One set of instants for the fixture and the assertions, so a stage time is
    // compared against the value actually stored.
    const ruleAt = recent(10);
    const reviewAt = recent(11);
    const humanAt = recent(12);
    await seedAudit([
      {
        ...record,
        trace: [
          { stage: 'rule', result: 'rule', at: ruleAt },
          { stage: 'review', result: 'review-escalate', at: reviewAt },
          { stage: 'human', result: 'human-deny', at: humanAt },
        ],
      },
    ]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
        rules: [],
      })),
    });
    try {
      await probe(host, session);
      const entry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'partial-chain',
      );
      // The full stored chain is used, and no stage was synthesised.
      expect(entry?.trace).toEqual(['rule', 'review-escalate', 'human-deny']);
      expect(entry?.result).toBe('human-deny');
      // The structured stages came from the audit rows, not from the projected
      // string list: each stage keeps its own reason and its own time, which the
      // projection does not carry. This is what "complete the chain from real
      // evidence" means, and it fails if the read is not consumed.
      const runtime = host
        .window('session-1')
        .find((candidate) => candidate.callId === 'partial-chain');
      expect(runtime?.stages?.map((stage) => stage.stage)).toEqual([
        'rule',
        'review',
        'human',
      ]);
      expect(runtime?.stages?.map((stage) => stage.result)).toEqual([
        'rule',
        'review-escalate',
        'human-deny',
      ]);
      expect(runtime?.stages?.[2]?.ts).toBe(humanAt);
    } finally {
      await host.dispose();
    }
  });

  test('a disagreement between the two sources is reported, not resolved', async () => {
    const session = makeSession('session-1');
    seedDecision(
      session,
      {
        version: 1,
        callId: 'conflicted',
        tool: 'bash',
        fingerprint: 'bash:conflicted',
        trace: ['rule', 'review'],
        result: 'review-deny',
        configRevision: 'rev-1',
        ts: recent(20),
      },
      recent(20),
    );
    await seedAudit([verdictRecord('conflicted', recent(20), 'human-deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
        rules: [],
      })),
    });
    try {
      await probe(host, session);
      const entry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'conflicted',
      );
      // The entry is present, keeps one conclusion, and carries the other
      // observation so neither reading is presented as the single truth.
      expect(entry).toBeDefined();
      expect(entry?.conflicts?.map((conflict) => conflict.field)).toContain(
        'result',
      );
      const conflict = entry?.conflicts?.find(
        (candidate) => candidate.field === 'result',
      );
      expect(conflict?.observed).toEqual(['review-deny', 'human-deny']);
      // The submission says its history is incomplete; it does not silently pick.
      expect(submittedHistoryBlock(host).missing.join(' ')).toContain(
        'history is incomplete',
      );
    } finally {
      await host.dispose();
    }
  });
});

describe('gaps, resets and bounded reads', () => {
  test('a confirmed empty session is reported as empty, not as unknown history', async () => {
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const block = submittedHistoryBlock(host);
      // Both sources answered and there is nothing to show: the reviewer is told
      // the window is empty, and nothing claims a source failed.
      expect(block.prior).toEqual([]);
      expect(block.missing.join(' ')).not.toContain('could not be recovered');
      expect(block.missing.join(' ')).not.toContain('history is incomplete');
    } finally {
      await host.dispose();
    }
  });

  test('an unreadable session log and an unavailable audit warn that history is unknown', async () => {
    const session = makeSession('session-1', [], { unreadable: true });
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
      auditDisabled: true,
      tolerateAdmissionFailure: true,
    });
    try {
      // The gate reads admission before history, and an unreadable log throws
      // there too, so this case reads the window directly: its subject is the
      // history gap, not the admission path.
      expect(host.window('session-1')).toEqual([]);
      const status = host.resetStatus('session-1');
      expect(status.coverage).toBe('unknown');
      const reason = status.reason ?? '';
      // Neither source answered, so "no prior verdicts" would be a false claim.
      expect(reason).toContain('could not be read');
      expect(reason).toContain('audit store is disabled');
    } finally {
      await host.dispose();
    }
  });

  test('only the audit source answering still recovers the history', async () => {
    const session = makeSession('session-1', [], { unreadable: true });
    await seedAudit([verdictRecord('audit-call', recent(0), 'review-deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'audit-only',
      tolerateAdmissionFailure: true,
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      // Same reason as above: the window is read directly because the gate cannot
      // admit a session whose log throws.
      expect(host.window('session-1').map((item) => item.callId)).toEqual([
        'audit-call',
      ]);
      const status = host.resetStatus('session-1');
      expect(status.coverage).toBe('partial');
      expect(status.reason ?? '').toContain('could not be read');
    } finally {
      await host.dispose();
    }
  });

  test('an explicit reset is not resurrected, while plain memory release recovers', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    // A verdict that genuinely predates the reset: its own decision time is in
    // the past, which is what makes "before the barrier" a real fact rather than
    // a fixture artefact.
    const beforeReset = recent(-120_000);
    seedDecision(
      session,
      {
        version: 2,
        callId: 'before-reset',
        tool: 'bash',
        fingerprint: 'bash:before-reset',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: beforeReset,
      },
      beforeReset,
    );
    await seedAudit([verdictRecord('before-reset', beforeReset, 'deny')]);

    // Control: a released runtime (no reset) recovers the verdict from the
    // durable sources. This is the behaviour an explicit reset must suppress.
    const control = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'control',
      config,
    });
    try {
      await probe(control, session);
      expect(windowOf(control)).toEqual(['before-reset']);
    } finally {
      await control.dispose();
    }

    const resetter = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'reset',
      config,
    });
    let barrierDurable: boolean;
    try {
      await settleRecords();
      resetter.reset(session);
      // The reset applies to the live runtime immediately.
      await probe(resetter, session);
      expect(windowOf(resetter)).toEqual([]);
      expect(appliedReset(resetter)).toBe(true);
      barrierDurable = session
        .snapshotEvents()
        .some((event) => event.type === 'plugin:arbiter/history-reset');
    } finally {
      await resetter.dispose();
    }

    const after = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'after-reset',
      config,
    });
    try {
      await probe(after, session);
      // With a durable barrier the later runtime honors it and rebuilds nothing.
      // Without the host's public writer there is no durable barrier, so the
      // pre-reset verdicts come back: that limit is asserted as data rather than
      // asserted conditionally, and it is why the barrier goes through the writer.
      expect({
        durable: barrierDurable,
        recovered: windowOf(after),
      }).toEqual(
        barrierDurable
          ? { durable: true, recovered: [] }
          : { durable: false, recovered: ['before-reset'] },
      );
    } finally {
      await after.dispose();
    }
  });

  test('a verdict settled after a reset is new history and is recovered', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    const beforeReset = recent(-120_000);
    seedDecision(
      session,
      {
        version: 2,
        callId: 'withdrawn',
        tool: 'bash',
        fingerprint: 'bash:withdrawn',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: beforeReset,
      },
      beforeReset,
    );
    await seedAudit([verdictRecord('withdrawn', beforeReset, 'deny')]);

    const resetter = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'reset-then-live',
      config,
    });
    try {
      await settleRecords();
      resetter.reset(session);
      // A decision formed after the reset is genuinely new history, not something
      // the barrier suppresses: the window must not stay empty forever.
      const afterReset = Date.now() + 1_000;
      seedDecision(
        session,
        {
          version: 2,
          callId: 'after-reset',
          tool: 'bash',
          fingerprint: 'bash:after-reset',
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: afterReset,
        },
        afterReset,
      );
      await probe(resetter, session);
      expect(windowOf(resetter)).toEqual(['after-reset']);
    } finally {
      await resetter.dispose();
    }
  });

  test('a long session with many non-decision events still recovers the window', async () => {
    const session = makeSession('session-1');
    // Real tool traffic around a small number of decisions. The reader must
    // select from the log it already has to materialize, and must not keep every
    // event it walks: the recovered window is what memory would have held.
    for (let index = 0; index < 400; index += 1) {
      session.append('tool/call', {
        callId: `t-${String(index)}`,
        name: 'bash',
        arguments: '{}',
      });
    }
    for (const [index, callId] of ['long-1', 'long-2'].entries()) {
      seedDecision(
        session,
        {
          version: 2,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: recent(index),
        },
        recent(index),
      );
      session.append('tool/call', {
        callId: `after-${callId}`,
        name: 'bash',
        arguments: '{}',
      });
    }
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'long-session',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        // A window below the tool-call population, so the merged submission is
        // still dominated by recent traffic and the verdict window is a fact the
        // runtime holds rather than something this request happens to display.
        context: { historyMaxItems: 10, checkpointMaxItems: 0 },
      })),
    });
    try {
      await probe(host, session);
      // The runtime window is the two recovered denials, oldest first, even
      // though the merged review input is filled by the surrounding tool calls.
      expect(host.window('session-1').map((entry) => entry.callId)).toEqual([
        'long-1',
        'long-2',
      ]);
      // And the submission accounts for the window it shows.
      expect(submittedHistoryBlock(host).missing.join(' ')).not.toContain(
        'could not be recovered',
      );
    } finally {
      await host.dispose();
    }
  });

  test('a capacity increase selects the older candidates it can still read', async () => {
    const session = makeSession('session-1');
    for (let index = 0; index < 4; index += 1) {
      seedDecision(
        session,
        {
          version: 2,
          callId: `cap-${String(index)}`,
          tool: 'bash',
          fingerprint: `bash:cap-${String(index)}`,
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: recent(index),
        },
        recent(index),
      );
    }
    const narrow = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'narrow',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 2 },
      })),
    });
    try {
      await probe(narrow, session);
      expect(windowOf(narrow)).toEqual(['cap-3', 'cap-2']);
    } finally {
      await narrow.dispose();
    }
    // A larger window on a fresh runtime backfills what the sources can still
    // supply, rather than keeping the previous runtime's narrower selection.
    const wide = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'wide',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(wide, session);
      expect(windowOf(wide)).toEqual(['cap-3', 'cap-2', 'cap-1', 'cap-0']);
    } finally {
      await wide.dispose();
    }
  });
});

describe('a record write that fails is visible to the next review', () => {
  test('a failed write makes the in-memory window partial and says why', async () => {
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'write-failure-visible',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await settleRecords();
      // Admission is already recorded. Dropping the writer now makes the *next*
      // record write fail, which is the failure this case is about: the session is
      // managed and decided, but its durable copy cannot be written.
      installSessionRecordApi(null);
      const decision = await callOnce(host, session, 'failed-write');
      expect(decision.kind).toBe('deny');
      expect(recordApiReady()).toBe(false);

      // The verdict is in memory, so no recovery will run for this window. The
      // published status must still disclose that the durable copy is missing.
      await probe(host, session);
      expect(host.resetStatus('session-1')).toMatchObject({
        coverage: 'partial',
      });
      const missing = submittedHistoryBlock(host).missing.join(' ');
      expect(missing).toContain('could not be written');
      // And the verdict itself is still usable: the gap is reported, not hidden
      // by dropping the entry.
      expect(windowOf(host)).toContain('failed-write');
    } finally {
      await host.dispose();
    }
  });

  test('a window with entries is never reported as an empty history', async () => {
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'not-known-empty',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await settleRecords();
      await callOnce(host, session, 'settled');
      // The control for the previous test: with a successful write the same path
      // reports a complete history, so "partial" above came from the failure and
      // not from the in-memory path being unconditionally pessimistic.
      const status = host.resetStatus('session-1');
      // The expected coverage is data, not a branch: the writer either resolved
      // (no gap) or it did not (every settlement is a reported gap). Both are
      // correct; what must never happen is "known-empty" while memory holds a
      // verdict, which is asserted separately.
      const expected = recordApiReady() ? 'complete' : 'partial';
      expect({ coverage: status.coverage, expected }).toEqual({
        coverage: expected,
        expected,
      });
    } finally {
      await host.dispose();
    }
  });

  test('a recovered write failure stops warning once a write succeeds', async () => {
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'failure-cleared',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await settleRecords();
      await callOnce(host, session, 'first');
      // Simulate the host writer becoming available: a successful record clears
      // the gap. The published status must be republished, not left stale — the
      // failure this test guards is a `partial` that outlives its cause.
      host.recordSucceeded('session-1');
      const after = host.resetStatus('session-1');
      expect({ coverage: after.coverage, reason: after.reason }).toEqual({
        coverage: 'complete',
        reason: null,
      });
    } finally {
      await host.dispose();
    }
  });
});

describe('cross-source contradictions and boundaries', () => {
  test('a session allow and an audit deny for one call are reported, not resolved', async () => {
    const session = makeSession('session-1');
    const ts = recent(0);
    // The same logical call judged differently by the two sources. The session
    // only kept the allow; SQLite recorded the deny.
    seedDecision(
      session,
      {
        version: 2,
        callId: 'contradicted',
        tool: 'bash',
        fingerprint: 'bash:contradicted',
        trace: ['allow'],
        result: 'allow',
        configRevision: 'rev-1',
        ts,
      },
      ts,
    );
    await seedAudit([verdictRecord('contradicted', ts, 'deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'contradicted',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const entry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'contradicted',
      );
      // The allow observation reached the merger, so the disagreement exists.
      expect(entry?.conflicts?.map((conflict) => conflict.field)).toContain(
        'result',
      );
      const resultConflict = entry?.conflicts?.find(
        (conflict) => conflict.field === 'result',
      );
      expect([...(resultConflict?.observed ?? [])].sort()).toEqual([
        'allow',
        'deny',
      ]);
      // It is presented as a contradiction, not as a settled denial.
      expect(submittedHistoryBlock(host).missing.join(' ')).toContain(
        'history is incomplete',
      );
    } finally {
      await host.dispose();
    }
  });

  test('an older persisted reset cannot undo a newer one from this runtime', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    // A reset that is already in the log, and a verdict that followed it.
    const firstReset = recent(-90_000);
    session.append('plugin:arbiter/history-reset', { at: firstReset });
    seedDecision(
      session,
      {
        version: 2,
        callId: 'between-resets',
        tool: 'bash',
        fingerprint: 'bash:between-resets',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: recent(-60_000),
      },
      recent(-60_000),
    );
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'two-resets',
      config,
    });
    try {
      await settleRecords();
      // A second reset happens now but its record cannot be written (no host
      // writer in plain CI), so it exists only in this runtime.
      host.reset(session);
      await probe(host, session);
      // The newer intent wins: reading the older persisted barrier must not
      // resurrect the verdict the newer reset withdrew.
      expect(windowOf(host)).toEqual([]);
      expect(appliedReset(host)).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  test('a reset after real verdicts reports an empty history, not a gap', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    // The ordinary explicit-reset shape: real verdicts existed, then the user
    // reset the history and settled nothing afterwards.
    const beforeReset = recent(-150_000);
    for (const [index, callId] of ['old-a', 'old-b'].entries()) {
      seedDecision(
        session,
        {
          version: 2,
          callId,
          tool: 'bash',
          fingerprint: `bash:${callId}`,
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: beforeReset + index,
        },
        beforeReset + index,
      );
    }
    await seedAudit([
      verdictRecord('old-a', beforeReset, 'deny'),
      verdictRecord('old-b', beforeReset + 1, 'deny'),
    ]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'reset-after-history',
      config,
    });
    try {
      await settleRecords();
      host.reset(session);
      await probe(host, session);
      // The withdrawal is deliberate, so this is an empty history — not an
      // unexplained absence, and not an incomplete read.
      expect(windowOf(host)).toEqual([]);
      expect(appliedReset(host)).toBe(true);
      const missing = submittedHistoryBlock(host).missing.join(' ');
      // The empty interval is not an unexplained absence. A write failure for the
      // barrier is still reported honestly — in plain CI the durable writer is
      // unavailable — but that is a persistence problem, not an ignorance of
      // whether verdicts existed.
      expect(missing).not.toContain('could not be recovered');
      expect(missing).not.toContain(
        'nothing in them proves the session never had one',
      );
    } finally {
      await host.dispose();
    }
  });

  test('two resets leave the latest interval empty even with a verdict between them', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    // reset T1 → deny A → reset T2 → nothing. A was withdrawn by T2, so the
    // current interval is empty by decision, not unknown. Both barriers are
    // written straight into the log so the test exercises the two-persisted-reset
    // branch regardless of whether this checkout can reach the host writer.
    const firstReset = recent(-180_000);
    const secondReset = recent(-60_000);
    session.append('plugin:arbiter/history-reset', { at: firstReset });
    const between = recent(-120_000);
    seedDecision(
      session,
      {
        version: 2,
        callId: 'between-resets',
        tool: 'bash',
        fingerprint: 'bash:between-resets',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: between,
      },
      between,
    );
    session.append('plugin:arbiter/history-reset', { at: secondReset });
    await seedAudit([verdictRecord('between-resets', between, 'deny')]);

    // A fresh runtime, so the classification comes from the log rather than from a
    // reset this process happened to perform.
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'two-resets-empty',
      config,
    });
    try {
      await probe(host, session);
      expect(windowOf(host)).toEqual([]);
      // The status itself is asserted: an empty window is only correct if it is
      // classified as a deliberate empty history.
      expect(host.resetStatus('session-1')).toMatchObject({
        coverage: 'known-empty',
        reset: true,
      });
      // The barrier came from the log, not from a reset this runtime performed —
      // that is what makes the scan order observable at all.
      expect(
        session
          .snapshotEvents()
          .filter((e) => e.type === 'plugin:arbiter/history-reset'),
      ).toHaveLength(2);
      const missing = submittedHistoryBlock(host).missing.join(' ');
      expect(missing).not.toContain('history is incomplete');
      expect(missing).not.toContain('could not be recovered');
      // And the exact wording the earlier revision checked with a typo.
      expect(missing).not.toContain(
        'nothing in them proves the session never had one',
      );
    } finally {
      await host.dispose();
    }
  });

  test('alternating observations of one call keep conflict evidence bounded', async () => {
    const session = makeSession('session-1');
    const ts = recent(0);
    // The stricter duplicate case: the same call is observed many times with two
    // different rejected results, so every merge could add another disagreement.
    for (let index = 0; index < 60; index += 1) {
      seedDecision(
        session,
        {
          version: 2,
          callId: 'alternating',
          tool: 'bash',
          fingerprint: 'bash:alternating',
          // Three distinct results, all of them candidates, so the merged entry
          // exceeds the representable bound and must say so.
          trace: index % 2 === 0 ? ['deny'] : ['review-deny'],
          result:
            index % 3 === 0
              ? 'deny'
              : index % 3 === 1
                ? 'review-deny'
                : 'human-deny',
          configRevision: 'rev-1',
          ts,
        },
        ts,
      );
    }
    await seedAudit([verdictRecord('alternating', ts, 'deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'alternating',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 1 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      const entry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'alternating',
      );
      expect(entry).toBeDefined();
      // Each conflicting field keeps at most two readings, so the evidence cannot
      // grow with the number of observations.
      for (const conflict of entry?.conflicts ?? []) {
        expect(conflict.observed.length).toBeLessThanOrEqual(2);
      }
      const fields = (entry?.conflicts ?? []).map((conflict) => conflict.field);
      expect(new Set(fields).size).toBe(fields.length);
      // The contradiction is still reported rather than resolved.
      expect(fields).toContain('result');
      // Three distinct results exceed the representable bound, so the entry says
      // so itself; the fact is carried by the entry and cannot leak to another
      // session or to a call the window dropped.
      expect(entry?.conflictsTruncated).toBe(true);
    } finally {
      await host.dispose();
    }
  });

  test('a bounded conflict in one session does not leak into another', async () => {
    const noisy = makeSession('session-noisy');
    const clean = makeSession('session-clean');
    const ts = recent(0);
    // One session with a call observed under three different results, so its entry
    // exceeds the representable bound.
    for (let index = 0; index < 9; index += 1) {
      seedDecision(
        noisy,
        {
          version: 2,
          callId: 'noisy-call',
          tool: 'bash',
          fingerprint: 'bash:noisy-call',
          trace: ['deny'],
          result:
            index % 3 === 0
              ? 'deny'
              : index % 3 === 1
                ? 'review-deny'
                : 'human-deny',
          configRevision: 'rev-1',
          ts,
        },
        ts,
      );
    }
    // A second session with an ordinary single verdict.
    seedDecision(
      clean,
      {
        version: 2,
        callId: 'clean-call',
        tool: 'bash',
        fingerprint: 'bash:clean-call',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts,
      },
      ts,
    );
    const host = await harness({
      sessions: new Map([
        ['session-noisy', noisy],
        ['session-clean', clean],
      ]),
      profile: 'no-leak',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      // The noisy session first, so anything global would already be set.
      await probe(host, noisy);
      const noisyEntry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'noisy-call',
      );
      expect(noisyEntry?.conflictsTruncated).toBe(true);

      // The clean session must not inherit that fact: the flag lives on the entry.
      await probe(host, clean);
      const cleanEntry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'clean-call',
      );
      expect(cleanEntry?.conflictsTruncated).toBeUndefined();
      // The clean session's own status must not carry the noisy one's bound.
      // Asserting on the clean status rather than on the last submission's text
      // keeps this about session scope instead of about which session was probed
      // most recently.
      expect(host.resetStatus('session-clean').reason ?? '').not.toContain(
        'exceeded what one entry can show',
      );
      expect(host.resetStatus('session-noisy').reason ?? '').toContain(
        'exceeded what one entry can show',
      );
    } finally {
      await host.dispose();
    }
  });

  test('an aggregated allow-side bound survives the merge with the audit deny', async () => {
    const session = makeSession('session-1');
    const ts = recent(0);
    // The session side folds three allow-family readings of one call; SQLite holds
    // the deny. The merged entry must keep the deny conclusion, still report the
    // contradiction, and keep the fact that more observations existed than the
    // entry can show.
    for (const result of ['allow', 'review-allow', 'human-allow'] as const) {
      seedDecision(
        session,
        {
          version: 2,
          callId: 'aggregated-bound',
          tool: 'bash',
          fingerprint: 'bash:aggregated-bound',
          trace: [result],
          result,
          configRevision: 'rev-1',
          ts,
        },
        ts,
      );
    }
    await seedAudit([verdictRecord('aggregated-bound', ts, 'deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'aggregated-bound',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 1 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      const entry = submittedHistory(host).find(
        (candidate) => candidate.callId === 'aggregated-bound',
      );
      expect(entry?.result).toBe('deny');
      expect(
        (entry?.conflicts ?? []).map((conflict) => conflict.field),
      ).toContain('result');
      // The bound is disclosed to the reviewer instead of being dropped when the
      // two sides merge.
      expect(entry?.conflictsTruncated).toBe(true);
      expect(submittedHistoryBlock(host).missing.join(' ')).toContain(
        'exceeded what one entry can show',
      );
    } finally {
      await host.dispose();
    }
  });

  test('many duplicate allow observations of one call stay one bounded entry', async () => {
    const session = makeSession('session-1');
    const ts = recent(0);
    // The counterexample from review: one call, hundreds of identical allow
    // records in the session, and a deny in SQLite.
    for (let index = 0; index < 200; index += 1) {
      seedDecision(
        session,
        {
          version: 2,
          callId: 'dup-allow',
          tool: 'bash',
          fingerprint: 'bash:dup-allow',
          trace: ['allow'],
          result: 'allow',
          configRevision: 'rev-1',
          ts,
        },
        ts,
      );
    }
    await seedAudit([verdictRecord('dup-allow', ts, 'deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'duplicate-observations',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 1 },
        breaker: { mode: 'off' },
      })),
    });
    try {
      await probe(host, session);
      const history = submittedHistory(host);
      // One logical call occupies one entry, and the disagreement is still shown.
      expect(history.length).toBe(1);
      expect(history[0]?.callId).toBe('dup-allow');
      expect(
        history[0]?.conflicts?.map((conflict) => conflict.field),
      ).toContain('result');
      // The runtime window is bounded by the configured capacity, not by the
      // number of duplicate records.
      expect(host.window('session-1').length).toBeLessThanOrEqual(1);
    } finally {
      await host.dispose();
    }
  });

  test('a verdict committed in the same millisecond as the reset survives recovery', async () => {
    const session = makeSession('session-1');
    const config = denyRuleConfig((base) => ({
      ...base,
      rules: [],
      context: { historyMaxItems: 10 },
    }));
    const old = recent(-120_000);
    seedDecision(
      session,
      {
        version: 2,
        callId: 'withdrawn',
        tool: 'bash',
        fingerprint: 'bash:withdrawn',
        trace: ['deny'],
        result: 'deny',
        configRevision: 'rev-1',
        ts: old,
      },
      old,
    );
    await seedAudit([verdictRecord('withdrawn', old, 'deny')]);

    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'same-millisecond',
      config,
    });
    try {
      await settleRecords();
      host.reset(session);
      // The barrier instant, then a real decision recorded at exactly that
      // instant and committed after the reset event.
      const barrier = Date.now();
      seedDecision(
        session,
        {
          version: 2,
          callId: 'same-instant',
          tool: 'bash',
          fingerprint: 'bash:same-instant',
          trace: ['deny'],
          result: 'deny',
          configRevision: 'rev-1',
          ts: barrier,
        },
        barrier,
      );
      await probe(host, session);
      // Event order, not the timestamp, decides: this verdict is after the reset
      // and must not be discarded just because its millisecond matches.
      expect(windowOf(host)).toEqual(['same-instant']);
    } finally {
      await host.dispose();
    }
  });

  test('a row this build cannot read cannot make the history look empty', async () => {
    // The exact gap this closes: SQLite holds a decision, but its record format is
    // one this build cannot interpret, so the window query filters it out. An empty
    // session log plus that filtered result must not be reported as "this session
    // never had a verdict".
    const session = makeSession('session-1');
    await seedAudit([verdictRecord('unreadable-format', recent(0), 'deny')]);
    // Rewrite the stored format to one no build reads.
    const db = new DatabaseSync(auditPath());
    try {
      db.prepare(
        'UPDATE calls SET record_format_version = ? WHERE call_id = ?',
      ).run(99, 'unreadable-format');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'unreadable-format',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const status = host.resetStatus('session-1');
      // Not known-empty: a row exists that this build cannot use.
      expect(status.coverage).toBe('partial');
      expect(status.reason ?? '').toContain('could not be interpreted');
      expect(submittedHistoryBlock(host).prior).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test('a refused audit database makes the history unknown, not empty', async () => {
    // The database exists and holds a decision, but its structure belongs to an
    // older release, so this build refuses it. An empty session log plus a
    // refused store must not be reported as "this session never had a verdict":
    // the refused source is unavailable, and that is what coverage has to say.
    await seedAudit([verdictRecord('refused-store', recent(0), 'deny')]);
    const db = new DatabaseSync(auditPath());
    try {
      db.exec('PRAGMA user_version = 1');
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'refused-store',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const status = host.resetStatus('session-1');
      // Neither "known-empty" nor "partial": the source could not be read at all.
      expect(status.coverage).not.toBe('known-empty');
      const reason = status.reason ?? '';
      expect(reason).toContain('reset');
      expect(submittedHistoryBlock(host).prior).toEqual([]);
    } finally {
      await host.dispose();
    }
  });

  test('a genuinely new session is still reported as an empty history', async () => {
    // The control: no rows at all, no decision history, so "known-empty" is the
    // correct answer. Introducing the unreadable count must not turn the common
    // first-review path into a gap.
    const session = makeSession('session-1');
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      profile: 'truly-new',
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      expect(host.resetStatus('session-1')).toMatchObject({
        coverage: 'known-empty',
        reason: null,
      });
    } finally {
      await host.dispose();
    }
  });

  test('an uninterpretable stored audit result makes the history partial', async () => {
    const session = makeSession('session-1');
    // A row this build cannot interpret: the store has a decision, the reader
    // does not know what it decided.
    // The column accepts the text; the reader is what refuses it.
    const unknown: CallRecord = {
      ...verdictRecord('unknown-result', recent(0), 'deny'),
    };
    Reflect.set(unknown, 'result', 'mystery');
    await seedAudit([unknown]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        rules: [],
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      await probe(host, session);
      const missing = submittedHistoryBlock(host).missing.join(' ');
      // The session is empty, but the audit row proves a decision exists, so
      // "empty" would be a false claim.
      expect(missing).toContain('could not be interpreted');
      expect(missing).toContain('history is incomplete');
      expect(submittedHistoryBlock(host).prior).toEqual([]);
    } finally {
      await host.dispose();
    }
  });
});

describe('recovery never changes the candidate window or overwrites newer state', () => {
  test('a recovery result cannot replace a verdict settled after it was read', async () => {
    const session = makeSession('session-1');
    // One durable verdict exists before the runtime starts.
    await seedAudit([verdictRecord('old-call', recent(0), 'deny')]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 10 },
      })),
    });
    try {
      // A live call is settled first, so memory holds the newer verdict.
      await callOnce(host, session, 'new-call');
      // The next review's window must contain both, in time order, with the
      // recovered older entry ahead of the live one.
      await probe(host, session);
      const history = windowOf(host);
      // Both survive, and the newer verdict is ahead in the displayed order: the
      // recovered older entry did not displace the one memory already held.
      expect(history).toContain('new-call');
      expect(history).toContain('old-call');
      expect(history.indexOf('new-call')).toBeLessThan(
        history.indexOf('old-call'),
      );
    } finally {
      await host.dispose();
    }
  });

  test('a shrinking capacity window keeps the newest verdicts and says it truncated', async () => {
    const session = makeSession('session-1');
    await seedAudit([
      verdictRecord('c1', recent(0), 'deny'),
      verdictRecord('c2', recent(1), 'deny'),
      verdictRecord('c3', recent(2), 'deny'),
      verdictRecord('c4', recent(3), 'deny'),
    ]);
    const host = await harness({
      sessions: new Map([['session-1', session]]),
      config: denyRuleConfig((base) => ({
        ...base,
        context: { historyMaxItems: 2 },
        rules: [],
      })),
    });
    try {
      await probe(host, session);
      expect(windowOf(host)).toEqual(['c4', 'c3']);
      // A cut window is a normal budget fact, reported as truncation.
      expect(submittedHistoryBlock(host).truncated).toBe(true);
      expect(submittedHistoryBlock(host).missing.join(' ')).not.toContain(
        'incomplete',
      );
    } finally {
      await host.dispose();
    }
  });
});
