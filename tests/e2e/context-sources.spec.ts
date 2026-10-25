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
import { buildReviewSnapshot, truncationFeedback } from '../../src/snapshot.js';
import type { SessionLike, SessionEventLike } from '../../src/snapshot.js';
import { DEFAULT_CONFIG } from '../../src/config.js';
import { renderRequest } from '../../src/reviewer.js';

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
    appendEvent(
      child,
      'user/message',
      createUserMessage({
        source: { kind: 'user', rpcId: 'rpc-child-1' },
        content: [{ type: 'text', text: 'run the child task' }],
      }),
    );
    appendEvent(child, 'tool/call', {
      turn: 1,
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
      turn: 1,
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

    const request = renderRequest(snapshot);
    check(
      'V8',
      'the rendered request carries the source ladder and the facts block',
      request.system.includes('## Authorization sources') &&
        request.user.includes('MATERIALS') &&
        request.user.includes('BUDGET'),
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
        context: { ...DEFAULT_CONFIG.context, maxInputTokens: 2_000 },
      },
      facts: null,
      priorVerdicts: [],
      sessionRecordGap: null,
    });
    check(
      'V9',
      'a real long program is trimmed inside the budget as an input fact',
      large.snapshot.action.truncated !== undefined &&
        large.snapshot.budget.truncatedSegments.includes('ACTION') &&
        large.snapshot.budget.estimatedInputTokens <= 2_000 &&
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
    });
    check(
      'V12',
      'outer run_code and its inner call are separate review inputs',
      outer.snapshot.tool === 'run_code' &&
        inner.snapshot.tool === 'bash' &&
        outer.snapshot.callId !== inner.snapshot.callId &&
        JSON.stringify(outer.snapshot.action.arguments).includes('tools.bash'),
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
