/**
 * Real-host verification for standing execution guidance (#21).
 *
 * What the model actually saw is the only honest evidence here, so this suite
 * reads the requests the deterministic fixture received, not the session log:
 * a log keeps historical messages even after a compaction replaced their span,
 * which cannot distinguish the effective prompt from an older one. The one
 * exception is the plugin's own committed decision records, which are read from
 * the log because that is where the plugin writes them.
 *
 * Cases: unmanaged vs managed vs disabled in one profile, a real delegation, a
 * real `/compact`, and the three approval modes driving a real
 * `ask_user_question` card.
 */
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

import { expect, test, type Page } from '@playwright/test';

import { createCaseHost, type CaseHost } from './dsh/case-host.js';
import type { DshHost } from './dsh/host.js';
import { resolveDshCommand } from './dsh/profile.js';
import { waitForSession, type LoggedSession } from './dsh/session-log.js';
import { startNewSession } from './dsh/ui.js';
import {
  PARENT_GUIDANCE,
  guidanceRegistration,
} from '../../src/host/guidance.js';

const FORMAT = 'arbiter-config-v3';

/** Distinctive fragments of the guidance, stable across rewording. */
const PARENT_MARKER = 'relay the answer with the original words';
const SUBAGENT_MARKER = 'report the pending operation';
/** The part every managed agent gets, whichever role it plays. */
const COMMON_MARKER = 'An approval-rejected tool call was not executed';

interface ArbiterStateBody {
  readonly config?: Record<string, unknown>;
  readonly effectiveRevision?: string;
  /** The profile patch revision a save must carry to pass its guard. */
  readonly fileRevision?: string | null;
}

interface LoggedRequest {
  readonly at: number;
  readonly system: string | null;
  readonly userTexts: readonly string[];
}

/**
 * Every model-visible text of one request, system and user roles alike.
 *
 * The guidance is registered on the host's runtime-context entry, which the
 * host materializes as a durable user-role snapshot rather than as a system
 * section (see docs/architecture.md#agent-instruction-placement). Both roles
 * are searched so an assertion about "what the model saw" cannot silently miss
 * the contribution because it arrived in the other role.
 */
function requestText(request: LoggedRequest): string {
  return [request.system ?? '', ...request.userTexts].join('\n');
}

/** The runtime-context snapshot contributions of one request. */
function runtimeContext(request: LoggedRequest): string {
  return request.userTexts
    .filter((text) => text.includes('Current runtime context'))
    .join('\n');
}

/**
 * The single runtime-context snapshot the host treats as effective.
 *
 * A snapshot message states that it supersedes earlier ones, so the last such
 * message in the request is the one the model is told to follow — the honest
 * target for "is this contribution still present".
 */
function latestRuntimeContext(request: LoggedRequest): string {
  const snapshots = request.userTexts.filter((text) =>
    text.includes('Current runtime context'),
  );
  return snapshots[snapshots.length - 1] ?? '';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function recordOf(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

async function arbiterState(host: DshHost): Promise<ArbiterStateBody> {
  const response = await fetch(`${host.origin}/api/arbiter/state`, {
    headers: { cookie: `${host.cookie.name}=${host.cookie.value}` },
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  const root = recordOf(body);
  return {
    config: recordOf(root['config']),
    ...(typeof root['effectiveRevision'] === 'string'
      ? { effectiveRevision: root['effectiveRevision'] }
      : {}),
    fileRevision:
      typeof root['fileRevision'] === 'string' ? root['fileRevision'] : null,
  };
}

/** Save one configuration draft through the product's own endpoint. */
async function saveConfig(
  host: DshHost,
  change: (config: Record<string, unknown>) => Record<string, unknown>,
): Promise<void> {
  const state = await arbiterState(host);
  const config = change(state.config ?? {});
  const response = await fetch(`${host.origin}/api/arbiter/config/save`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    // The route's guard is the profile patch revision, not the effective
    // configuration revision; a mismatch is a conflict, so read it from state.
    body: JSON.stringify({ revision: state.fileRevision, config }),
  });
  const body: unknown = await response.json();
  expect(response.status, JSON.stringify(body)).toBe(200);
  expect(body).toMatchObject({ ok: true, effective: true });
}

async function setMainMode(
  host: DshHost,
  mode: 'ask' | 'no-ask',
): Promise<void> {
  await saveConfig(host, (config) => ({
    ...config,
    modes: { main: mode, subagent: 'no-ask' },
  }));
  // A save returning 200 is not the same as the mode being in effect; read the
  // effective configuration back before a call is made under it.
  const applied = await arbiterState(host);
  expect(recordOf(recordOf(applied.config)['modes'])['main']).toBe(mode);
}

async function enableSession(host: DshHost, sessionId: string): Promise<void> {
  const response = await fetch(`${host.origin}/api/arbiter/sessions`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, action: 'enable' }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ admission: { enabled: true, managed: true } });
}

async function disableSession(host: DshHost, sessionId: string): Promise<void> {
  const response = await fetch(`${host.origin}/api/arbiter/sessions`, {
    method: 'POST',
    headers: {
      cookie: `${host.cookie.name}=${host.cookie.value}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ sessionId, action: 'disable' }),
  });
  expect(response.status).toBe(200);
  const body: unknown = await response.json();
  expect(body).toMatchObject({ admission: { enabled: false, managed: false } });
}

/** Every conversation request the fixture received, oldest first. */
async function requests(directory: string): Promise<readonly LoggedRequest[]> {
  const files = (await readdir(directory).catch(() => [] as string[]))
    .filter((name) => name.endsWith('.json'))
    .sort();
  const out: LoggedRequest[] = [];
  for (const file of files) {
    const raw = await readFile(join(directory, file), 'utf8');
    const parsed: unknown = JSON.parse(raw);
    if (!isRecord(parsed)) continue;
    const userTexts: unknown = parsed['userTexts'];
    out.push({
      at: typeof parsed['at'] === 'number' ? parsed['at'] : 0,
      system: typeof parsed['system'] === 'string' ? parsed['system'] : null,
      userTexts: Array.isArray(userTexts)
        ? userTexts.filter((text): text is string => typeof text === 'string')
        : [],
    });
  }
  return out;
}

/**
 * The one request whose user-role text carries `marker`.
 *
 * A marker appears in exactly one conversation request, because the fixture
 * answers it with a single tool call and the following step re-sends the same
 * history. Matching the marker is therefore a precise identity rather than
 * "any later request".
 */
async function requestFor(
  directory: string,
  marker: string,
  timeoutMs = 60_000,
): Promise<LoggedRequest> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = (await requests(directory)).find((entry) =>
      entry.userTexts.some((text) => text.includes(marker)),
    );
    if (found !== undefined) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`no model request carried ${marker}`);
}

/** Open one existing session from the sidebar by its own title. */
async function openExistingSession(
  page: Page,
  titleFragment: string,
): Promise<void> {
  const row = page.getByRole('treeitem', { name: new RegExp(titleFragment) });
  await expect(row.first()).toBeVisible();
  await row.first().click();
  await expect(page.locator('[contenteditable="true"]').first()).toBeVisible();
  // The client resolves the session through its own stream before the session
  // is live on the host, so give it the same settle a human sees.
  await page.waitForTimeout(1500);
}

/** Open the isolated host in the browser with its own bootstrap cookie. */
async function openHost(page: Page, host: DshHost): Promise<void> {
  await page
    .context()
    .addCookies([{ ...host.cookie, url: host.origin, httpOnly: true }]);
  await page.goto(host.origin);
  const preview = page.getByRole('dialog', { name: /预览版说明|Preview/i });
  if (await preview.isVisible().catch(() => false)) {
    await preview.getByRole('button', { name: /^(继续|Continue)$/ }).click();
  }
  const gettingStarted = page.getByRole('dialog', {
    name: /开始使用|Get started/i,
  });
  if (await gettingStarted.isVisible().catch(() => false)) {
    await gettingStarted
      .getByRole('button', { name: /^(关闭|Close)$/ })
      .click();
  }
}

async function sendPrompt(page: Page, text: string): Promise<void> {
  const composer = page.locator('[contenteditable="true"]').first();
  await expect(composer).toBeVisible();
  await composer.click();
  await page.keyboard.insertText(text);
  await page.keyboard.press('Enter');
}

/** Wait for the session whose log carries `marker`, without a session id. */
async function sessionWithMarker(
  host: DshHost,
  marker: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.events.some(
        (event) =>
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes(marker),
      ),
    timeoutMs,
  );
  if (session === null) throw new Error(`no session carried ${marker}`);
  return session;
}

/** Wait for one session's settled turn carrying `marker`. */
async function settledTurnWith(
  host: DshHost,
  sessionId: string,
  marker: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) =>
      candidate.sessionId === sessionId &&
      candidate.events.some(
        (event) =>
          event.type === 'user/message' &&
          JSON.stringify(event.data).includes(marker),
      ) &&
      candidate.events.some((event) => event.type === 'turn/end'),
    timeoutMs,
  );
  if (session === null) throw new Error(`no settled turn carried ${marker}`);
  return session;
}

/** Wait for the session object of one id to carry `predicate`. */
async function waitFor(
  host: DshHost,
  predicate: (session: LoggedSession) => boolean,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(host.home, predicate, timeoutMs);
  if (session === null)
    throw new Error('the expected session state never appeared');
  return session;
}

/**
 * Wait for one session's ask call carrying `question` plus its own answer.
 *
 * The answer is matched by the exact call id, so a previous iteration's
 * authorization result can never stand in for the current mode's call.
 */
async function waitForAnswer(
  host: DshHost,
  sessionId: string,
  question: string,
  timeoutMs = 90_000,
): Promise<LoggedSession> {
  const session = await waitForSession(
    host.home,
    (candidate) => {
      if (candidate.sessionId !== sessionId) return false;
      const call = askCalls(candidate).find((entry) =>
        JSON.stringify(entry['arguments']).includes(question),
      );
      if (call === undefined) return false;
      const rawCallId: unknown = call['callId'];
      if (typeof rawCallId !== 'string') return false;
      return candidate.events.some((event) => {
        if (event.type !== 'tool/result') return false;
        const source = recordOf(
          recordOf(recordOf(event.data)['message'])['source'],
        );
        return source['callId'] === rawCallId;
      });
    },
    timeoutMs,
  );
  if (session === null)
    throw new Error(`no answered ask call carried ${question}`);
  return session;
}

/** Every decision record the plugin committed for one session. */
function decisions(session: LoggedSession): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'plugin:arbiter/decision')
    .map((event) => recordOf(event.data));
}

/** The session's `ask_user_question` calls, as the host logged them. */
function askCalls(session: LoggedSession): readonly Record<string, unknown>[] {
  return session.events
    .filter((event) => event.type === 'tool/call')
    .map((event) => recordOf(event.data))
    .filter((data) => data['name'] === 'ask_user_question');
}

/** One request directory under the case root. */
async function prepareRequestDir(root: string, name: string): Promise<string> {
  const directory = join(root, name);
  await mkdir(directory, { recursive: true });
  return directory;
}

/**
 * The pinned host pieces this suite assembles against.
 *
 * The complete-persona case must run the host's own assembly: a fake registry
 * could not prove that the real `SystemPrompt` keeps a `required` context when
 * a persona replaces every section.
 */
interface HostPrompt {
  section(registration: unknown): () => void;
  context(registration: unknown): () => void;
  getSectionOrder(name: string): number;
  getContextOrder(name: string): number;
  suppressRuntimeContext(): () => void;
  assemble(context: unknown): Promise<{
    readonly sections: readonly { readonly name: string }[];
    readonly contexts: readonly { readonly name: string }[];
  }>;
}

/** A host class that is only ever called through `Reflect.construct`. */
interface HostConstructor {
  readonly construct: (args: readonly unknown[]) => unknown;
}

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}

function constructorOf(value: unknown, label: string): HostConstructor {
  if (typeof value !== 'function')
    throw new TypeError(`pinned host export ${label} is not a constructor`);
  return {
    construct: (args) => Reflect.construct(value, args) as unknown,
  };
}

function constructChecked<T>(
  value: HostConstructor,
  args: readonly unknown[],
  accepts: (candidate: unknown) => candidate is T,
): T {
  const created: unknown = value.construct(args);
  if (!accepts(created))
    throw new TypeError('constructed host object lacks the required members');
  return created;
}

function isHostPrompt(value: unknown): value is HostPrompt {
  if (!isRecordValue(value)) return false;
  for (const member of [
    'section',
    'context',
    'getSectionOrder',
    'getContextOrder',
    'suppressRuntimeContext',
    'assemble',
  ] as const) {
    if (typeof value[member] !== 'function') return false;
  }
  return true;
}

interface PluginScope {
  plugin(callback: (scope: unknown) => void): unknown;
}

function isPluginScope(value: unknown): value is PluginScope {
  return isRecordValue(value) && typeof value['plugin'] === 'function';
}

interface HostAssembly {
  readonly createContext: () => PluginScope;
  readonly constructPrompt: (scope: unknown) => HostPrompt;
  readonly promptAt: (scope: unknown) => HostPrompt;
  readonly createScope: (ctx: unknown, key: object) => PluginScope;
  readonly personaSection: string;
  readonly renderPrompt: (assembly: unknown) => string;
  readonly renderContext: (assembly: unknown) => string;
}

async function loadHostAssembly(): Promise<HostAssembly> {
  const command = await resolveDshCommand();
  const entry = command.args[0];
  if (entry === undefined)
    throw new Error('DSH_E2E_CLI must point at the host entry for this test.');
  const hostRoot = entry.slice(0, entry.indexOf('/node_modules/@deepseek-ai/'));
  const requireFromHost = createRequire(join(hostRoot, 'package.json'));
  const load = async (name: string): Promise<Record<string, unknown>> => {
    const loaded: unknown = await import(requireFromHost.resolve(name));
    if (!isRecordValue(loaded))
      throw new TypeError(`${name} namespace is not an object`);
    return loaded;
  };
  const cordis = await load('@deepseek-ai/cordis');
  const systemPrompt = await load('@deepseek-ai/dsh-system-prompt');
  const scope = await load('@deepseek-ai/dsh-scope');
  const context = constructorOf(cordis['Context'], 'Context');
  const prompt = constructorOf(systemPrompt['SystemPrompt'], 'SystemPrompt');
  const createScope = scope['createScope'];
  const personaSection = systemPrompt['PERSONA_PREFIX_SECTION'];
  const renderPrompt = systemPrompt['renderPrompt'];
  const renderContext = systemPrompt['renderContextSnapshot'];
  if (
    typeof createScope !== 'function' ||
    typeof personaSection !== 'string' ||
    typeof renderPrompt !== 'function' ||
    typeof renderContext !== 'function'
  ) {
    throw new TypeError('pinned host exports are missing a required member');
  }
  return {
    createContext: () => constructChecked(context, [], isPluginScope),
    constructPrompt: (scoped) =>
      constructChecked(prompt, [scoped, {}], isHostPrompt),
    // A scoped context inherits the registry, so its own access resolves the
    // same instance through that scope: registering there creates that scope's
    // layer rather than colliding with the root one.
    promptAt: (scoped) => {
      const service = isRecordValue(scoped)
        ? scoped['systemPrompt']
        : undefined;
      if (!isHostPrompt(service))
        throw new TypeError('the host scope exposes no prompt registry');
      return service;
    },
    createScope: (ctx, key): PluginScope => {
      const created: unknown = Reflect.apply(createScope, undefined, [
        ctx,
        key,
      ]);
      const scoped = isRecordValue(created) ? created['ctx'] : undefined;
      if (!isPluginScope(scoped))
        throw new TypeError('the host scope factory returned no context');
      return scoped;
    },
    personaSection,
    renderPrompt: (assembly) =>
      String(Reflect.apply(renderPrompt, undefined, [assembly])),
    renderContext: (assembly) =>
      String(Reflect.apply(renderContext, undefined, [assembly])),
  };
}

/** Ask a scoped context to run one plugin body and settle its fiber. */
async function runPlugin(
  scope: unknown,
  body: (scoped: unknown) => void,
): Promise<void> {
  const plugin = isRecordValue(scope) ? scope['plugin'] : undefined;
  if (typeof plugin !== 'function')
    throw new TypeError('the host scope exposes no plugin()');
  const fiber: unknown = Reflect.apply(plugin, scope, [body]);
  await Promise.resolve(fiber).then(
    () => undefined,
    () => undefined,
  );
}

test('the guidance survives a complete persona and context suppression', async () => {
  const host = await loadHostAssembly();
  const ctx = host.createContext();
  const box: { prompt?: HostPrompt; root?: unknown } = {};
  await runPlugin(ctx, (scoped) => {
    box.prompt = host.constructPrompt(scoped);
    box.root = scoped;
  });
  const prompt = box.prompt;
  if (prompt === undefined || box.root === undefined)
    throw new Error('the pinned prompt registry did not mount');

  // A per-agent scope with a complete persona: the shipped `minimal` preset.
  // The host then reduces the system prompt to that one section.
  const key = {};
  const agentScope = host.createScope(box.root, key);
  await runPlugin(agentScope, (scoped) => {
    const scopedPrompt = host.promptAt(scoped);
    scopedPrompt.section({
      name: host.personaSection,
      order: scopedPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX'),
      text: 'PERSONA-ONLY',
      complete: true,
    });
  });

  // The same persona also disables optional runtime context, and the product's
  // own registration is added here: only a `required` context survives both.
  prompt.suppressRuntimeContext();
  prompt.context(
    guidanceRegistration(
      prompt.getContextOrder('APPROVAL_POLICY') + 1,
      () => PARENT_GUIDANCE,
    ),
  );
  const assembly = await prompt.assemble({ scope: key });
  // The complete persona really did replace the sections …
  expect(assembly.sections.map((section) => section.name)).toEqual([
    host.personaSection,
  ]);
  expect(host.renderPrompt(assembly)).toBe('PERSONA-ONLY');
  // … and the guidance is still in the runtime context the model receives.
  expect(assembly.contexts.map((entry) => entry.name)).toContain(
    'arbiter:agent-guidance',
  );
  const snapshot = host.renderContext(assembly);
  expect(snapshot).toContain('An approval-rejected tool call was not executed');
  expect(snapshot).toContain(PARENT_GUIDANCE);
});

test.describe('standing agent guidance', () => {
  test(
    'a managed main session carries the guidance, an unmanaged one carries none, and disabling removes it',
    { tag: '@smoke' },
    async ({ page }, testInfo) => {
      const artifacts = testInfo.outputPath('guidance-scope');
      const requestDir = await prepareRequestDir(artifacts, 'requests');
      const caseHost: CaseHost = await createCaseHost(artifacts, {
        arbiterRowConfig: { format: FORMAT, rules: [] },
        requestDir,
      });
      try {
        const host = caseHost.current();

        // An unenabled session: the plugin must contribute nothing at all.
        await openHost(page, host);
        await sendPrompt(page, 'GUIDE-PLAIN RUN echo guide-plain');
        const plainSession = await sessionWithMarker(host, 'GUIDE-PLAIN');
        const plainRequest = await requestFor(requestDir, 'GUIDE-PLAIN');
        expect(requestText(plainRequest)).not.toContain(COMMON_MARKER);
        expect(requestText(plainRequest)).not.toContain(PARENT_MARKER);

        // Enabling the same session makes the next request carry it.
        await enableSession(host, plainSession.sessionId);
        await openHost(page, host);
        await sendPrompt(page, 'GUIDE-MANAGED RUN echo guide-managed');
        const managed = await settledTurnWith(
          host,
          plainSession.sessionId,
          'GUIDE-MANAGED',
        );
        expect(managed.sessionId).toBe(plainSession.sessionId);
        const managedRequest = await requestFor(requestDir, 'GUIDE-MANAGED');
        // The contribution really is part of the host's runtime-context
        // snapshot, not some text the test could have assembled itself.
        const managedContext = runtimeContext(managedRequest);
        expect(managedContext).toContain(COMMON_MARKER);
        // A main session runs its own calls, so it gets the common
        // non-execution semantics plus the parent's subtask handling.
        expect(managedContext).toContain(PARENT_MARKER);
        expect(managedContext).not.toContain(SUBAGENT_MARKER);

        // A second session in the same host is still unmanaged: guidance is
        // per admission, not per installation.
        await openHost(page, host);
        const otherSessionId = await startNewSession(page);
        await sendPrompt(page, 'GUIDE-OTHER RUN echo guide-other');
        const other = await sessionWithMarker(host, 'GUIDE-OTHER');
        // The prompt must land in the session the host just created, not in the
        // one the page was showing before the click.
        expect(other.sessionId).toBe(otherSessionId);
        expect(other.sessionId).not.toBe(plainSession.sessionId);
        const otherRequest = await requestFor(requestDir, 'GUIDE-OTHER');
        expect(requestText(otherRequest)).not.toContain(COMMON_MARKER);

        // Disabling the admitted session removes the contribution again: the
        // scope is read per assembly, never cached at enable time.
        await disableSession(host, plainSession.sessionId);
        await openHost(page, host);
        // The page is on the other session now, so reopen the admitted one:
        // the prompt must continue that session to prove its own scope.
        await openExistingSession(page, 'GUIDE-PLAIN');
        await sendPrompt(
          page,
          'GUIDE-AFTER-DISABLE RUN echo guide-after-disable',
        );
        await settledTurnWith(
          host,
          plainSession.sessionId,
          'GUIDE-AFTER-DISABLE',
        );
        const afterDisable = await requestFor(
          requestDir,
          'GUIDE-AFTER-DISABLE',
        );
        // The contribution lives in the user-role runtime-context snapshot, so
        // this must inspect that snapshot, not the system prompt. Earlier
        // snapshots stay in the conversation by design (each supersedes the last
        // rather than erasing it), so the *latest* snapshot is the effective
        // one — asserting over the whole history would fail even when the
        // contribution is correctly gone.
        const latestContext = latestRuntimeContext(afterDisable);
        expect(latestContext.length).toBeGreaterThan(0);
        expect(latestContext).not.toContain(COMMON_MARKER);
        expect(latestContext).not.toContain(PARENT_MARKER);
        // The newest snapshot really is newer than the managed turn's, so this
        // is a fresh projection rather than the retained one.
        const managedSnapshots = afterDisable.userTexts.filter((text) =>
          text.includes('Current runtime context'),
        );
        expect(managedSnapshots.length).toBeGreaterThan(1);
      } finally {
        await caseHost.dispose();
      }
    },
  );

  test('a managed subagent carries the reporting guidance', async ({
    page,
  }, testInfo) => {
    const artifacts = testInfo.outputPath('guidance-subagent');
    const requestDir = await prepareRequestDir(artifacts, 'requests');
    const caseHost: CaseHost = await createCaseHost(artifacts, {
      arbiterRowConfig: { format: FORMAT, rules: [] },
      requestDir,
    });
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-PARENT RUN echo guide-parent-warmup');
      const parentSession = await sessionWithMarker(host, 'GUIDE-PARENT');
      await enableSession(host, parentSession.sessionId);

      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-DELEGATE DELEGATE echo guide-child');
      // The child's own turn is the request carrying the delegated task.
      const childContext = runtimeContext(
        await requestFor(requestDir, 'Delegated task'),
      );
      expect(childContext).toContain(COMMON_MARKER);
      expect(childContext).toContain(SUBAGENT_MARKER);
      expect(childContext).not.toContain(PARENT_MARKER);
      // The parent's own request in that same turn still has the parent text.
      const parentContext = runtimeContext(
        await requestFor(requestDir, 'GUIDE-DELEGATE'),
      );
      expect(parentContext).toContain(PARENT_MARKER);
      expect(parentContext).not.toContain(SUBAGENT_MARKER);
    } finally {
      await caseHost.dispose();
    }
  });

  test('the guidance is present in the request after a real compaction', async ({
    page,
  }, testInfo) => {
    const artifacts = testInfo.outputPath('guidance-compact');
    const requestDir = await prepareRequestDir(artifacts, 'requests');
    const caseHost: CaseHost = await createCaseHost(artifacts, {
      arbiterRowConfig: { format: FORMAT, rules: [] },
      requestDir,
    });
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C1 RUN echo compact-one');
      const session = await sessionWithMarker(host, 'GUIDE-C1');
      await enableSession(host, session.sessionId);
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C2 RUN echo compact-two');
      await settledTurnWith(host, session.sessionId, 'GUIDE-C2');
      const beforeCompaction = await requestFor(requestDir, 'GUIDE-C2');
      expect(runtimeContext(beforeCompaction)).toContain(PARENT_MARKER);

      // The host's own `/compact`: a real compaction transaction.
      await openHost(page, host);
      await sendPrompt(page, '/compact');
      const compacted = await waitFor(
        host,
        (candidate) =>
          candidate.sessionId === session.sessionId &&
          candidate.events.some((event) => event.type === 'compaction/end'),
      );
      expect(
        compacted.events.filter((event) => event.type === 'compaction/end')
          .length,
      ).toBeGreaterThan(0);

      // The next turn's *actual request* must still carry the guidance. Reading
      // the accumulated log could not distinguish this from an older prompt.
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-C3 RUN echo compact-three');
      await settledTurnWith(host, session.sessionId, 'GUIDE-C3');
      const afterCompaction = await requestFor(requestDir, 'GUIDE-C3');
      // The guidance is re-projected after the span holding the previous
      // snapshot was replaced, so the model still receives it.
      const afterContext = runtimeContext(afterCompaction);
      expect(afterContext).toContain(COMMON_MARKER);
      expect(afterContext).toContain(PARENT_MARKER);
    } finally {
      await caseHost.dispose();
    }
  });

  test('all three approval modes still let the agent ask and never record the answer as human-allow', async ({
    page,
  }, testInfo) => {
    const artifacts = testInfo.outputPath('guidance-ask');
    const requestDir = await prepareRequestDir(artifacts, 'requests');
    const caseHost: CaseHost = await createCaseHost(artifacts, {
      arbiterRowConfig: { format: FORMAT, rules: [] },
      requestDir,
    });
    try {
      const host = caseHost.current();
      await openHost(page, host);
      await sendPrompt(page, 'GUIDE-ASK-WARMUP RUN echo ask-warmup');
      const warmup = await sessionWithMarker(host, 'GUIDE-ASK-WARMUP');
      await enableSession(host, warmup.sessionId);

      // Both modes keep the host's own ask tool working: the plugin's mode governs
      // only whether it opens its own approval, never whether the agent may ask.
      for (const mode of ['ask', 'no-ask'] as const) {
        await setMainMode(host, mode);
        await openHost(page, host);
        const marker = `GUIDE-ASK-${mode.toUpperCase()}`;
        const question = `是否允许执行 ${mode} 的 /workspace/app/build 清理？`;
        await sendPrompt(page, `${marker} ASK ${question}`);

        // The host's own question card appears: the plugin neither answered it
        // nor suppressed it in this mode.
        const card = page.getByRole('radiogroup').first();
        await expect(card).toBeVisible({ timeout: 60_000 });
        await expect(
          page.getByText(question, { exact: false }).first(),
        ).toBeVisible();
        await card.getByRole('radio', { name: '允许', exact: true }).click();
        await page.getByRole('button', { name: '提交', exact: true }).click();

        // Wait for this iteration's own ask call and its answer. The call id is
        // the identity: the answer is the tool result the host recorded for
        // that exact call, so an earlier authorization result cannot satisfy it.
        const answered = await waitForAnswer(host, warmup.sessionId, question);
        const call = askCalls(answered).find((entry) =>
          JSON.stringify(entry['arguments']).includes(question),
        );
        expect(call, `${mode} must issue its own ask call`).toBeDefined();
        const rawCallId: unknown = call?.['callId'];
        const callId = typeof rawCallId === 'string' ? rawCallId : '';
        expect(callId.length).toBeGreaterThan(0);

        const callDecisions = decisions(answered).filter(
          (entry) => entry['callId'] === callId,
        );
        expect(
          callDecisions.length,
          `${mode} ask call must be decided by the plugin`,
        ).toBeGreaterThan(0);
        for (const decision of callDecisions) {
          // The call was admitted (not refused) in this mode, and an answer is
          // never recorded as an approval.
          expect([
            'allow',
            'review-allow',
            'force-ask',
            'review-escalate',
          ]).toContain(decision['result']);
          expect(decision['result']).not.toBe('human-allow');
        }
        // The answer reached the model as the host's own tool result for this
        // exact call, and it carries the human's choice.
        const answerResult = answered.events.find((event) => {
          if (event.type !== 'tool/result') return false;
          const message = recordOf(recordOf(event.data)['message']);
          return recordOf(message['source'])['callId'] === callId;
        });
        expect(answerResult, `${mode} answer must be recorded`).toBeDefined();
        const answerContent = recordOf(recordOf(answerResult?.data)['message'])[
          'content'
        ];
        expect(JSON.stringify(answerContent)).toContain('允许');
        // The request for this mode's marker carried the guidance under the
        // mode that was confirmed effective above.
        const request = await requestFor(requestDir, marker);
        expect(runtimeContext(request)).toContain(COMMON_MARKER);
        expect(runtimeContext(request)).toContain(PARENT_MARKER);
      }
    } finally {
      await caseHost.dispose();
    }
  });
});
