/**
 * Standing recovery guidance for execution agents in managed sessions.
 *
 * The text is deliberately short and stable: it tells a model what an
 * approval-rejected call means, that a permitted alternative comes first, and
 * how to ask for help when it is genuinely blocked. Everything specific — the
 * mode in effect, the actual denial reason, the evidence a review lacked —
 * arrives with the tool result, so this module never reads or repeats it.
 *
 * Scope is the backend-confirmed admission, not an installation flag or a host
 * preset name: a session the plugin has not taken over gets no guidance, and a
 * subagent inherits its parent's admission exactly as the gate does.
 *
 * Placement is the host's registered runtime-context entry
 * (`ctx.systemPrompt.context()`), which the architecture note already designates
 * for this guidance. It is registered as `required`, for two verified reasons in
 * the pinned host:
 *   - a deployment persona with `complete: true` (the shipped `minimal` preset)
 *     replaces every prompt *section* with itself, so a section registration
 *     would silently disappear in that composition while the runtime contexts
 *     are untouched;
 *   - `includeRuntimeContext: false` drops optional contexts but keeps
 *     `required` ones.
 * A runtime snapshot is also re-projected after a compaction replaces the span
 * that held it, so the guidance returns on the next request. The text therefore
 * stays identical between requests and never grows the history by itself.
 * The reviewer keeps its own separate contract in `reviewer/prompt.ts`.
 */

import type { AgentLike } from '../snapshot.js';
import type { SessionKind } from '../types.js';
import { sessionKindOf } from './common.js';
import type { SessionAdmissions } from './session-admission.js';
import type {
  HostEnvironment,
  PromptContextRegistrationLike,
  SystemPromptLike,
} from './types.js';

/** The unique name this contribution registers under. */
export const GUIDANCE_SECTION = 'arbiter:agent-guidance';

/**
 * The part every managed agent needs, regardless of role.
 *
 * It states what a rejected call means and the order of recovery: a permitted
 * alternative first, a request for help only when that is not enough. It never
 * claims which approval mode is active, why a particular call failed, or which
 * evidence a review lacked — all of that arrives with the tool result.
 */
export const COMMON_GUIDANCE =
  'An approval-rejected tool call was not executed. First try an allowed alternative that the stated reason permits. Do not repeat the same blocked effect with different wording while the conditions are unchanged; after the authorization or the operation scope changes you may submit again.';

/**
 * What a subagent additionally does when genuinely blocked.
 *
 * It reports upward rather than inventing authority, and says exactly what the
 * parent needs in order to decide.
 */
export const SUBAGENT_GUIDANCE = `${COMMON_GUIDANCE} When genuinely blocked, report the pending operation, the blocking reason and the help you need to the parent agent.`;

/**
 * What a parent agent additionally does when a subtask asks for help.
 *
 * A request for help is a planning question first: adjust the plan when that is
 * enough, and only then ask the user — precisely, through whatever asking
 * surface the host offers. Asking is never restricted by the approval mode, and
 * the relay keeps the human's original words and scope unchanged.
 */
export const PARENT_GUIDANCE = `${COMMON_GUIDANCE} When a subtask is blocked by permissions and asks for help, first judge whether the plan can be adjusted. When more authorization is needed, state the exact operation and scope through the ask surface available to you or in chat, then relay the answer to the subtask with the original words and authorization scope unchanged. Approval modes do not restrict these questions. A subtask review may use the parent session original human words; only when the authorization still cannot be verified or is insufficient should you guide the user to confirm directly in the subtask session.`;

/** The standing text for one orchestration role. */
export function guidanceText(kind: SessionKind): string {
  return kind === 'subagent' ? SUBAGENT_GUIDANCE : PARENT_GUIDANCE;
}

/**
 * Check the host service this module registers against.
 *
 * The composition is optional: a host without the prompt registry simply gets
 * no guidance, and a service that does not offer the two calls used here is
 * treated the same way rather than trusted as a cast.
 */
function isSystemPrompt(value: unknown): value is SystemPromptLike {
  if (value === null || typeof value !== 'object') return false;
  return (
    typeof Reflect.get(value, 'context') === 'function' &&
    typeof Reflect.get(value, 'getContextOrder') === 'function'
  );
}

export interface GuidanceScope {
  /** Whether this plugin is currently deciding calls at all. */
  readonly active: boolean;
  /** Whether the backend confirms this session is taken over. */
  readonly managed: boolean;
  readonly kind: SessionKind;
}

/**
 * The guidance one session should receive, or `''` for none.
 *
 * Two independent facts must both hold: the plugin is deciding calls right now,
 * and this session is inside the backend-confirmed admission. Neither an
 * installation, a host preset nor a stored admission alone is enough.
 */
export function selectGuidance(scope: GuidanceScope): string {
  if (!scope.active || !scope.managed) return '';
  return guidanceText(scope.kind);
}

/**
 * The one registration this module contributes, for a given order.
 *
 * Exported so the host-compatibility proof can register it on the real
 * `SystemPrompt` together with a complete persona, instead of re-deriving the
 * shape in a test.
 */
export function guidanceRegistration(
  order: number,
  textFor: (agent: AgentLike | undefined) => string,
): PromptContextRegistrationLike {
  return {
    name: GUIDANCE_SECTION,
    order,
    // Literal prose, never a template: no current mode, failure, or evidence.
    interpolate: false,
    // A complete persona replaces every section, and
    // `includeRuntimeContext: false` drops optional contexts. Only a required
    // context survives both, and the guidance must not silently vanish just
    // because the deployment chose one of those compositions.
    required: true,
    text: (context) => textFor(context.agent),
  };
}

export class AgentGuidance {
  private readonly host: HostEnvironment;
  private readonly admissions: SessionAdmissions;

  constructor(host: HostEnvironment, admissions: SessionAdmissions) {
    this.host = host;
    this.admissions = admissions;
  }

  /**
   * Contribute the guidance through the host's public system-prompt registry.
   *
   * The service is resolved through `inject` like every other optional host
   * service, so a composition without it simply gets no contribution instead of
   * failing the plugin. The registration belongs to that injected scope and is
   * released with it (and with this plugin's effect) on unload.
   */
  register(): void {
    this.host.ctx.inject(['systemPrompt'], (child) => {
      const prompt = child.get('systemPrompt');
      if (!isSystemPrompt(prompt)) return;
      child.effect(
        () => prompt.context(this.registration(prompt)),
        'arbiter agent guidance',
      );
    });
  }

  /** The registration handed to the host registry. */
  private registration(
    prompt: SystemPromptLike,
  ): PromptContextRegistrationLike {
    // Immediately after the host's own approval-policy line: the guidance
    // explains what an Arbiter rejection means, not what the policy is.
    return guidanceRegistration(
      prompt.getContextOrder('APPROVAL_POLICY') + 1,
      (agent) => this.textFor(agent),
    );
  }

  /**
   * The text for one assembly, decided at assembly time.
   *
   * Admission is read from the session log through the same backend view the
   * state API serves, so a session enabled (or left) mid-conversation changes
   * its guidance with no separate bookkeeping here. An agentless assembly, an
   * unknown session and an unconfirmed session all contribute nothing.
   */
  textFor(agent: AgentLike | undefined): string {
    const session = agent?.session;
    const sessionId = session?.id;
    if (agent === undefined || session === undefined || sessionId === undefined)
      return '';
    const { runtime } = this.host;
    // Check the cheap fact first: a disabled or unloading plugin contributes
    // nothing, so it must not pay for an admission fold on every assembly.
    const active = runtime.config.enabled && runtime.accepting;
    if (!active) return '';
    // Remember the session object before reading its admission: an assembly can
    // happen before this session ever reached the gate, and the fold needs the
    // object to resolve a parent chain or a cold-restored record.
    this.admissions.observe(session);
    const view = this.admissions.view(sessionId, runtime.effectiveRevision);
    return selectGuidance({
      active,
      managed: view !== null && view.managed,
      kind: sessionKindOf(agent),
    });
  }
}
