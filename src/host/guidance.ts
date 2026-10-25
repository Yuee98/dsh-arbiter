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
 * subagent inherits its parent's admission exactly as the gate does. The
 * contribution is the host's public system-prompt section entry — the same one
 * the first-party tool packages use for their own standing instructions — so it
 * stays in the system prompt every step and is never inside a compacted span.
 * The reviewer keeps its own separate contract in `reviewer/prompt.ts`.
 */

import type { AgentLike } from '../snapshot.js';
import type { SessionKind } from '../types.js';
import { sessionKindOf } from './common.js';
import type { SessionAdmissions } from './session-admission.js';
import type {
  HostEnvironment,
  PromptSectionRegistrationLike,
  SystemPromptLike,
} from './types.js';

/** The unique name this contribution registers under. */
export const GUIDANCE_SECTION = 'arbiter:agent-guidance';

/**
 * Guidance for a subagent.
 *
 * It states the meaning of a rejected call, the order of recovery (a permitted
 * alternative first), and the report a parent needs. It never claims which
 * approval mode is active or why a particular call failed.
 */
export const SUBAGENT_GUIDANCE =
  'An approval-rejected tool call was not executed. First try an allowed alternative that the stated reason permits. When genuinely blocked, report the pending operation, the blocking reason and the help you need to the parent agent. After the authorization or the operation scope changes you may submit again; do not repeat the same blocked effect with different wording while the conditions are unchanged.';

/**
 * Guidance for a parent agent.
 *
 * A subagent's request for help is a planning question first: adjust the plan
 * when that is enough, and only then ask the user — precisely, through whatever
 * asking surface the host offers. Asking is never restricted by the approval
 * mode, and the answer is relayed without widening its scope.
 */
export const PARENT_GUIDANCE =
  'When a subtask is blocked by permissions and asks for help, first judge whether the plan can be adjusted. When more authorization is needed, state the exact operation and scope through the ask surface available to you or in chat, then relay the answer to the subtask accurately. Approval modes do not restrict these questions. A subtask review may use the parent session original human words; only when the authorization still cannot be verified or is insufficient should you guide the user to confirm directly in the subtask session.';

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
    typeof Reflect.get(value, 'section') === 'function' &&
    typeof Reflect.get(value, 'getSectionOrder') === 'function'
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
        () => prompt.section(this.registration(prompt)),
        'arbiter agent guidance',
      );
    });
  }

  /** The registration handed to the host registry. */
  private registration(
    prompt: SystemPromptLike,
  ): PromptSectionRegistrationLike {
    return {
      name: GUIDANCE_SECTION,
      // Immediately after the deployment persona and before the first-party
      // tool instructions: the paragraph frames how a blocked call is read, so
      // it belongs with the standing instructions rather than with one tool.
      order: prompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1,
      // Literal prose, never a template: no current mode, failure, or evidence.
      interpolate: false,
      text: (context) => this.textFor(context.agent),
    };
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
    // Remember the session object before reading its admission: an assembly can
    // happen before this session ever reached the gate, and the fold needs the
    // object to resolve a parent chain or a cold-restored record.
    this.admissions.observe(session);
    const { runtime } = this.host;
    const view = this.admissions.view(sessionId, runtime.effectiveRevision);
    return selectGuidance({
      active: runtime.config.enabled && runtime.accepting,
      managed: view !== null && view.managed,
      kind: sessionKindOf(agent),
    });
  }
}
