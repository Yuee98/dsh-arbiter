/**
 * Real-host verification for review-input sources (#11).
 *
 * Uses the pinned DSH `Session` implementation from the same isolated runtime the
 * browser suite launches, appends the exact events the host writes (human
 * message, ask call + its real result, timed user-question-reply, agent relay,
 * compaction summary) and runs the built plugin's snapshot builder against them.
 *
 * No model request is made and no user profile is touched: the chat backend is
 * only rendered to prove what would have been submitted.
 */
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { resolveDshCommand } from './dsh/profile.js';
import {
  buildReviewSnapshot,
  materialAvailabilityOf,
  truncationFeedback,
} from '../../src/snapshot.js';
import type { SessionLike, SessionEventLike } from '../../src/snapshot.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { renderChatRequest } from '../../src/reviewer.js';

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));

interface HostSessions {
  readonly Session: {
    create(
      id: string,
      seed: undefined,
      header: Record<string, unknown>,
    ): HostSession;
  };
  readonly createUserMessage: (input: {
    source: Record<string, unknown>;
    content: readonly { readonly type: 'text'; readonly text: string }[];
  }) => unknown;
  readonly createToolResultMessage: (input: {
    callId: string;
    content: readonly { readonly type: 'text'; readonly text: string }[];
    isError: boolean;
  }) => unknown;
}

interface HostSession extends SessionLike {
  snapshotEvents(): readonly SessionEventLike[];
  append(
    type: string,
    data: unknown,
    opts?: { readonly surfaceOp: 'append' },
  ): unknown;
}

const SURFACE_TYPES = new Set([
  'user/message',
  'developer/message',
  'system/message',
  'assistant/message',
  'tool/result',
]);

/** A real creation header for the pinned session format. */
function hostHeader(
  id: string,
  cwd: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    version: 4,
    id,
    createdAt: Date.now(),
    isSeeded: false,
    cwd,
    ...extra,
  };
}

function appendEvent(session: HostSession, type: string, data: unknown): void {
  session.append(
    type,
    data,
    ...(SURFACE_TYPES.has(type) ? [{ surfaceOp: 'append' as const }] : []),
  );
}

interface DispatchEvidence {
  readonly outerCallId: string;
  readonly outerName: string;
  readonly innerCallId: string | null;
  readonly innerName: string | null;
  readonly resultText: string;
  readonly originalProgramChars: number;
  readonly executedProgramChars: number;
}

/** The slice of a Cordis plugin scope this harness needs. */
interface HostToolRuntime {
  register(definition: unknown): unknown;
  execute(input: unknown): Promise<{
    readonly isError?: boolean;
    readonly content?: readonly { readonly text?: string }[];
  }>;
}

interface HostModules {
  readonly Context: new () => {
    plugin(callback: (scope: unknown) => void): unknown;
  };
  readonly SystemPrompt: new (scope: unknown, config: unknown) => unknown;
  readonly LocalSubprocessRuntime: new (
    scope: unknown,
    config: unknown,
  ) => unknown;
  readonly LocalFileSystem: new (scope: unknown, config: unknown) => unknown;
  readonly NodePtcRuntime: new (scope: unknown, config: unknown) => unknown;
  readonly ToolRuntime: new (
    scope: unknown,
    config: unknown,
  ) => HostToolRuntime;
  readonly defineContentToolFixture: (options: unknown) => unknown;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

/**
 * The three scope members this harness calls.
 *
 * The host's own scope object is still passed to host constructors unchanged,
 * because services register against its identity; this adapter only wraps the
 * members we call so the test owns the exact surface it uses.
 */
interface ScopeMembers {
  provide(name: string, value: unknown): void;
  on(event: string, handler: (...args: never[]) => unknown): () => void;
  get(name: string): unknown;
}

function scopeMembers(value: unknown): ScopeMembers {
  if (!isRecordValue(value))
    throw new TypeError('plugin scope is not an object');
  const provide = value['provide'];
  const on = value['on'];
  const get = value['get'];
  if (
    typeof provide !== 'function' ||
    typeof on !== 'function' ||
    typeof get !== 'function'
  ) {
    throw new TypeError('plugin scope lacks provide/on/get');
  }
  return {
    provide(name, provided) {
      Reflect.apply(provide, value, [name, provided]);
    },
    on(event, handler) {
      const disposer: unknown = Reflect.apply(on, value, [event, handler]);
      return () => {
        if (typeof disposer === 'function') {
          Reflect.apply(disposer, undefined, []);
        }
      };
    },
    get(name) {
      const member: unknown = Reflect.apply(get, value, [name]);
      return member;
    },
  };
}

/** Check each constructor/callable export without widening to `any`. */
function isHostModules(value: unknown): value is HostModules {
  if (!isRecordValue(value)) return false;
  const constructors = [
    'Context',
    'SystemPrompt',
    'LocalSubprocessRuntime',
    'LocalFileSystem',
    'NodePtcRuntime',
    'ToolRuntime',
  ] as const;
  for (const key of constructors) {
    if (typeof value[key] !== 'function') return false;
  }
  return typeof value['defineContentToolFixture'] === 'function';
}

/**
 * Import the pinned host's own packages by absolute path.
 *
 * The spec runs from this checkout, so the host packages are resolved from its
 * installation and every module is validated before use instead of being
 * trusted as `any`.
 */
async function loadHostModules(
  resolve: (name: string) => string,
): Promise<HostModules> {
  const entries = await Promise.all(
    [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-system-prompt',
      '@deepseek-ai/dsh-subprocess-local',
      '@deepseek-ai/dsh-fs-local',
      '@deepseek-ai/dsh-ptc-runtime-node',
      '@deepseek-ai/dsh-tools',
    ].map(async (name) => {
      const loaded: unknown = await import(resolve(name));
      return loaded;
    }),
  );
  const [cordis, systemPrompt, subprocess, fs, ptc, tools] = entries;
  if (
    !isRecordValue(cordis) ||
    !isRecordValue(systemPrompt) ||
    !isRecordValue(subprocess) ||
    !isRecordValue(fs) ||
    !isRecordValue(ptc) ||
    !isRecordValue(tools)
  ) {
    throw new TypeError('a host module namespace is not an object');
  }
  const candidate = {
    Context: cordis['Context'],
    SystemPrompt: systemPrompt['SystemPrompt'],
    LocalSubprocessRuntime: subprocess['LocalSubprocessRuntime'],
    LocalFileSystem: fs['LocalFileSystem'],
    NodePtcRuntime: ptc['NodePtcRuntime'],
    ToolRuntime: tools['ToolRuntime'],
    defineContentToolFixture: tools['defineContentToolFixture'],
  };
  if (!isHostModules(candidate)) {
    throw new TypeError('pinned host modules are missing a required export');
  }
  return candidate;
}

/**
 * Execute one real `run_code` program whose body calls an inner `tools.bash`,
 * using the pinned host's own ToolRuntime inside a plugin scope.
 *
 * The scope is required: the PTC worker, fs and subprocess services resolve
 * through the plugin context, and `tools/pre-execute` fires on the same context
 * for both the outer program and the inner dispatch.
 */
async function runRealOuterInnerDispatch(
  hostRoot: string,
): Promise<DispatchEvidence> {
  const requireFromHost = createRequire(join(hostRoot, 'package.json'));
  const host = await loadHostModules((name) => requireFromHost.resolve(name));

  const program =
    'const r = await tools.bash({ command: "echo inner" });\nreturn r;';
  const admissions: { callId: string; name: string; root: string | null }[] =
    [];
  const executed: string[] = [];
  const ctx = new host.Context();
  const box: { runtime?: HostToolRuntime } = {};
  ctx.plugin(function setup(scoped: unknown) {
    const scope = scopeMembers(scoped);
    new host.SystemPrompt(scoped, {});
    new host.LocalSubprocessRuntime(scoped, {});
    new host.LocalFileSystem(scoped, { diffBasisMaxBytes: 1_048_576 });
    scope.provide('sandboxPolicy', {
      defaultMode: 'danger-full-access',
      resolve: () => ({ mode: 'danger-full-access' }),
    });
    scope.provide('workingDirectory', {
      ensure: () => Promise.resolve(tmpdir()),
    });
    new host.NodePtcRuntime(scoped, {
      launch: { kind: 'node-script', executable: process.execPath },
      maxOutputBytes: 65_536,
      maxMessageBytes: 1_048_576,
      maxPendingCalls: 16,
      maxOldGenerationSizeMb: 256,
      timeoutMs: 8_000,
      maxTimeoutMs: 15_000,
      graceMs: 800,
    });
    const runtime = new host.ToolRuntime(scoped, { mode: 'ptc' });
    scope.on(
      'tools/pre-execute',
      (exec: unknown, next: () => Promise<{ kind: string }>) => {
        if (exec !== null && typeof exec === 'object') {
          const name: unknown = Reflect.get(exec, 'name');
          const rootCallId: unknown = Reflect.get(exec, 'rootCallId');
          admissions.push({
            callId: String(Reflect.get(exec, 'callId') as unknown),
            name: String(name),
            root: typeof rootCallId === 'string' ? rootCallId : null,
          });
          if (name === 'run_code') {
            const args: unknown = Reflect.get(exec, 'arguments');
            if (args !== null && typeof args === 'object') {
              const code: unknown = Reflect.get(args, 'code');
              if (typeof code === 'string') executed.push(code);
            }
          }
        }
        return next();
      },
    );
    runtime.register(
      host.defineContentToolFixture({
        name: 'bash',
        description: 'run a shell command',
        parameters: { command: { type: 'string', required: true } },
        execute: (args: unknown) => {
          const command =
            args !== null && typeof args === 'object'
              ? String(Reflect.get(args, 'command'))
              : '';
          return Promise.resolve([{ type: 'text', text: `ran ${command}` }]);
        },
      }),
    );
    box.runtime = runtime;
  });
  await new Promise((resolve) => setTimeout(resolve, 700));

  const runtime = box.runtime;
  if (runtime === undefined) throw new Error('tool runtime did not mount');
  const session = {
    id: 'sr-dispatch',
    header: { id: 'sr-dispatch', cwd: tmpdir() },
    snapshotEvents: () => [],
    deriveMessages: () => [],
    append: () => undefined,
  };
  const result = await runtime.execute({
    callId: 'dispatch-outer-1',
    name: 'run_code',
    arguments: { code: program, description: 'inner call' },
    // A real agent carries its scoped context; the PTC retained environment
    // registers its release effect on it.
    agent: { session, ctx },
    signal: new AbortController().signal,
  });
  const outer = admissions.find((entry) => entry.name === 'run_code');
  const inner = admissions.find((entry) => entry.name !== 'run_code');
  return {
    outerCallId: outer?.callId ?? '',
    outerName: outer?.name ?? '',
    innerCallId: inner?.callId ?? null,
    innerName: inner?.name ?? null,
    resultText: (result.content ?? [])
      .map((block) => block.text ?? '')
      .join('\n'),
    originalProgramChars: program.length,
    executedProgramChars: executed[0]?.length ?? 0,
  };
}

test('real DSH sessions expose human originals, ask answers and compaction', async () => {
  const command = await resolveDshCommand();
  // Resolve the host's own packages from its installation, not this checkout.
  const entry = command.args[0];
  if (entry === undefined) {
    throw new Error('DSH_E2E_CLI must point at the host entry for this test.');
  }
  const hostRoot = entry.slice(0, entry.indexOf('/node_modules/@deepseek-ai/'));
  const requireFromHost = createRequire(join(hostRoot, 'package.json'));
  const sessionModule: unknown = await import(
    requireFromHost.resolve('@deepseek-ai/dsh-session')
  );
  const llmModule: unknown = await import(
    requireFromHost.resolve('@deepseek-ai/dsh-llm')
  );
  const host = (sessionModule ?? {}) as Partial<HostSessions>;
  const llm = (llmModule ?? {}) as Partial<HostSessions>;
  if (
    host.Session === undefined ||
    llm.createUserMessage === undefined ||
    llm.createToolResultMessage === undefined
  ) {
    throw new Error('pinned DSH session/llm exports are unavailable');
  }
  const { Session } = host;
  const createUserMessage = llm.createUserMessage;
  const createToolResultMessage = llm.createToolResultMessage;

  const root = await mkdtemp(join(tmpdir(), 'arbiter-context-sources-'));
  const workspace = join(root, 'workspace');
  const artifacts = join(repoRoot, '.local', 'e2e', 'context-sources');
  await mkdir(join(workspace, '.dsh'), { recursive: true });
  await mkdir(artifacts, { recursive: true });
  await writeFile(
    join(workspace, '.dsh', 'arbiter.md'),
    'Never upload logs; build artifacts may be removed.',
    'utf8',
  );
  const checks: { id: string; description: string; passed: boolean }[] = [];
  const check = (id: string, description: string, passed: boolean): void => {
    checks.push({ id, description, passed });
  };
  try {
    // --- parent session: a real human original ---------------------------
    const parentId = 'sr-verify-parent';
    const parent = Session.create(
      parentId,
      undefined,
      hostHeader(parentId, workspace),
    );
    appendEvent(
      parent,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-parent-1' },
        content: [
          {
            type: 'text',
            text: 'delete only the build directory; keep everything else',
          },
        ],
      }),
    );

    // --- child: ask answer, timed reply, relay, sibling relay, checkpoint -
    const childId = 'sr-verify-child';
    const child = Session.create(
      childId,
      undefined,
      hostHeader(childId, workspace, {
        parentSession: parentId,
        origin: 'subagent',
        delegationDepth: 1,
      }),
    );
    // The host's own turn boundary, written the way it writes it: an earlier
    // turn with real tool history, then the current turn.
    appendEvent(child, 'turn/start', { turn: 1 });
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-child-1' },
        content: [{ type: 'text', text: 'run the child task' }],
      }),
    );
    // A human permission in turn 1 that stays in force afterwards.
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-child-standing' },
        content: [
          {
            type: 'text',
            text: 'build output may be deleted from now on; never upload logs',
          },
        ],
      }),
    );
    appendEvent(child, 'tool/call', {
      turn: 1,
      step: 1,
      callId: 'old-turn-call',
      name: 'bash',
      arguments: { command: 'echo from the earlier turn' },
    });
    appendEvent(child, 'tool/result', {
      turn: 1,
      step: 1,
      message: createToolResultMessage({
        callId: 'old-turn-call',
        content: [{ type: 'text', text: 'from the earlier turn' }],
        isError: false,
      }),
    });
    appendEvent(child, 'turn/end', { turn: 1, reason: 'completed' });
    appendEvent(child, 'turn/start', { turn: 2 });
    appendEvent(child, 'tool/call', {
      turn: 2,
      step: 1,
      callId: 'ask-fg',
      name: 'ask_user_question',
      arguments: {
        questions: [
          { id: 'q1', question: 'May the agent delete /workspace/app/build?' },
        ],
      },
    });
    // The host envelope nests the message under `data.message`; that is what a
    // reader of the session log actually sees.
    appendEvent(child, 'tool/result', {
      turn: 2,
      step: 1,
      message: createToolResultMessage({
        callId: 'ask-fg',
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              answers: [{ id: 'q1', selected: ['同意'] }],
            }),
          },
        ],
        isError: false,
      }),
    });
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: {
          kind: 'user-question-reply',
          callId: 'ask-late',
          outcome: 'answered',
        },
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              kind: 'answer_to_pending_question',
              tool: 'ask_user_question',
              callId: 'ask-late',
              questions: [
                {
                  id: 'q2',
                  question: 'Should the agent push the release branch?',
                },
              ],
              answers: [{ id: 'q2', selected: [], custom: 'yes, push it' }],
            }),
          },
        ],
      }),
    );
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'agent-message', senderSessionId: parentId },
        content: [{ type: 'text', text: 'the user approved the deletion' }],
      }),
    );
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'agent-message', senderSessionId: 'sr-verify-sibling' },
        content: [{ type: 'text', text: 'sibling says anything goes' }],
      }),
    );
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'compact-checkpoint' },
        content: [
          {
            type: 'text',
            text: 'Earlier: the task was to clean build output.',
          },
        ],
      }),
    );

    const built = await buildReviewSnapshot({
      agent: { session: child },
      sessions: { get: (id) => (id === parentId ? parent : undefined) },
      tool: 'bash',
      arguments: { command: 'rm -rf build' },
      callId: 'verify-call',
      cwd: workspace,
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'verify',
    });
    const snapshot = built.snapshot;

    check(
      'V1',
      'direct parent human original is read from the real parent Session',
      snapshot.evidence.some(
        (item) =>
          item.source.kind === 'parent-human' && item.evidence === 'explicit',
      ),
    );
    check(
      'V2',
      'a foreground ask answer is explicit and carries its question',
      snapshot.evidence.some(
        (item) =>
          item.askCallId === 'ask-fg' &&
          item.text.includes('同意') &&
          (item.question ?? '').includes('/workspace/app/build'),
      ),
    );
    check(
      'V15',
      'the current turn is the host turn, and earlier-turn tool calls are excluded',
      // The host wrote a real turn/end before turn 2, so the newest open turn is
      // this call's; the turn-1 call was a real tool/call with a result.
      snapshot.turn === 2 &&
        snapshot.context.length === 1 &&
        !snapshot.context.some((call) =>
          call.arguments.includes('from the earlier turn'),
        ) &&
        snapshot.completeness.items.some(
          (item) => item.kind === 'unrelated' && !item.blocking,
        ),
    );
    check(
      'V16',
      'a human permission given in an earlier turn still applies and names its turn',
      snapshot.evidence.some(
        (item) =>
          item.turn === 1 &&
          item.evidence === 'explicit' &&
          item.text.includes('build output may be deleted'),
      ) && snapshot.evidence.some((item) => item.turn === 2),
    );
    check(
      'V17',
      'a real readable session with no blocking gap is available to score',
      snapshot.completeness.status !== 'insufficient' &&
        materialAvailabilityOf(snapshot.completeness).status === 'available',
    );
    check(
      'V3',
      'a timed user-question-reply answer is mapped with its question',
      snapshot.evidence.some(
        (item) =>
          item.askCallId === 'ask-late' &&
          item.text.includes('yes, push it') &&
          (item.question ?? '').includes('release branch'),
      ),
    );
    check(
      'V4',
      'the direct-parent relay is implied and the sibling relay is excluded',
      snapshot.evidence.filter((item) => item.source.kind === 'parent-relay')
        .length === 1 &&
        snapshot.evidence.some(
          (item) =>
            item.source.kind === 'parent-relay' &&
            !item.text.includes('sibling'),
        ),
    );
    check(
      'V5',
      'compaction is readable and marked, and its summary never authorizes',
      snapshot.checkpoints.length === 1 &&
        snapshot.missing.join(' ').includes('compacted') &&
        !snapshot.evidence.some((item) =>
          item.text.includes('Earlier: the task'),
        ),
    );
    check(
      'V6',
      'PROJECT_RULES is read from the workspace and reported as present',
      (snapshot.projectRules ?? '').includes('Never upload logs') &&
        snapshot.materials.some(
          (item) =>
            item.id === 'project-rules' &&
            item.present &&
            item.path === '.dsh/arbiter.md',
        ),
    );
    check(
      'V7',
      'parent authorization presence is true, not inferred from a relay',
      snapshot.parentAuthorizationPresent === true,
    );

    const request = renderChatRequest(snapshot);
    check(
      'V8',
      'the rendered request carries the contract, the material blocks and the source ladder',
      request.system.includes('REVIEW_CONTRACT') &&
        request.system.includes('PROJECT_RULES') &&
        request.user.includes('POLICY_AND_GUIDANCE') &&
        request.user.includes('MATERIAL_COMPLETENESS'),
    );

    // --- a long program: only the submission shrinks ---------------------
    const longId = 'sr-verify-long';
    const longSession = Session.create(
      longId,
      undefined,
      hostHeader(longId, workspace),
    );
    appendEvent(
      longSession,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-long' },
        content: [{ type: 'text', text: 'run the helper program' }],
      }),
    );
    const program = 'console.log("chunk");\n'.repeat(3_000);
    const large = await buildReviewSnapshot({
      agent: { session: longSession },
      tool: 'run_code',
      arguments: { code: program, description: 'helper' },
      callId: 'verify-long',
      cwd: workspace,
      config: {
        ...DEFAULT_CONFIG,
        context: {
          ...DEFAULT_CONFIG.context,
          // Above the shared contract's own preamble, so the action is the thing
          // that has to yield rather than the request being unfittable.
          maxInputTokens: 3_400,
        },
      },
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'verify',
    });
    check(
      'V9',
      'a real long program is trimmed inside the budget as an input fact',
      large.snapshot.action.truncated !== undefined &&
        large.snapshot.budget.truncatedSegments.includes('ACTION') &&
        large.snapshot.budget.estimatedInputTokens <= 3_400 &&
        large.snapshot.missing
          .join(' ')
          .includes('truncated by the input budget'),
    );
    check(
      'V10',
      'truncation feedback is a non-causal hint for the decision layer',
      (truncationFeedback(large.snapshot) ?? '').includes('Input completeness'),
    );
    check(
      'V11',
      'the trimmed action keeps the original length, not an untrimmed copy',
      large.snapshot.action.truncated?.originalChars === program.length &&
        large.snapshot.action.programText !== undefined &&
        large.snapshot.action.programText.length ===
          large.snapshot.action.truncated.retainedChars,
    );

    // --- outer run_code vs its inner tools.* call ------------------------
    const outerId = 'sr-verify-outer';
    const outerSession = Session.create(
      outerId,
      undefined,
      hostHeader(outerId, workspace),
    );
    appendEvent(
      outerSession,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-outer' },
        content: [{ type: 'text', text: 'run the small helper program' }],
      }),
    );
    const innerProgram =
      'const r = await tools.bash({ command: "echo inner" });\n';
    const outer = await buildReviewSnapshot({
      agent: { session: outerSession },
      tool: 'run_code',
      arguments: { code: innerProgram, description: 'inner call' },
      callId: 'verify-outer',
      cwd: workspace,
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'verify',
    });
    const inner = await buildReviewSnapshot({
      agent: { session: outerSession },
      tool: 'bash',
      arguments: { command: 'echo inner' },
      callId: 'verify-outer:inner:1',
      cwd: workspace,
      config: DEFAULT_CONFIG,
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
      configRevision: 'verify',
    });
    check(
      'V12',
      'outer run_code and its inner call are separate review inputs',
      outer.snapshot.tool === 'run_code' &&
        inner.snapshot.tool === 'bash' &&
        outer.snapshot.callId !== inner.snapshot.callId &&
        JSON.stringify(outer.snapshot.action.arguments).includes('tools.bash'),
    );

    // --- real host dispatch: outer run_code -> inner tools.* ---------------
    // A genuine ToolRuntime from the pinned runtime executes the program; both
    // the outer admission and the inner call must pass `tools/pre-execute`, and
    // the executed arguments must stay complete regardless of review trimming.
    const dispatch = await runRealOuterInnerDispatch(hostRoot);
    check(
      'V13',
      'a real run_code program dispatches an inner tools.* call through two independent admissions',
      dispatch.innerCallId !== null &&
        dispatch.innerCallId !== dispatch.outerCallId &&
        dispatch.innerName === 'bash' &&
        dispatch.outerName === 'run_code' &&
        dispatch.resultText.includes('ran echo inner'),
    );
    check(
      'V14',
      'the executed program text is the complete original, not the review submission',
      dispatch.executedProgramChars === dispatch.originalProgramChars &&
        dispatch.executedProgramChars > 0,
    );
    await writeFile(
      join(artifacts, 'dispatch.json'),
      `${JSON.stringify(dispatch, null, 2)}\n`,
      'utf8',
    );
    const hostVersion: unknown = JSON.parse(
      await readFile(
        join(hostRoot, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
        'utf8',
      ),
    );
    await writeFile(
      join(artifacts, 'report.json'),
      `${JSON.stringify(
        {
          at: new Date().toISOString(),
          hostVersion,
          modelRequests: 'none',
          realEventCounts: {
            parent: parent.snapshotEvents().length,
            child: child.snapshotEvents().length,
          },
          dispatch,
          checks,
        },
        null,
        2,
      )}\n`,
      'utf8',
    );

    const failed = checks.filter((entry) => !entry.passed);
    expect(failed.map((entry) => entry.id)).toEqual([]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
