/**
 * The session row that carries one Arbiter denial.
 *
 * Why a row and not a marker inside the host's tool card: the host exposes
 * exactly two Tool-owned slots — the keyed `tool.call.toolview`, where an
 * occupied key *replaces* that tool's whole view, and `tool.call.images` for
 * galleries. There is no per-call decoration slot. Taking over `tool.call.toolview`
 * would mean reimplementing the host's terminal, read, diff, search and web
 * cards, so the plugin contributes its own business row instead, anchored to the
 * same `callId` and therefore the same call position.
 *
 * The row is derived from one durable fact and nothing else: the recorded
 * `tool/result` whose structured failure identity is Arbiter's. That identity is
 * written by the host from the plugin's `deny()` and survives replay, so no new
 * approval state machine is introduced, and a call Arbiter allowed — even one
 * whose body then failed in the host sandbox — produces no row at all.
 */

import type { ReactNode } from 'react';

import type { ArbiterI18n } from '../i18n.js';
import { ArbiterI18nProvider } from '../i18n-provider.js';
import type {
  ConversationDefinitionPort,
  ConversationLocationPort,
} from '../view-types.js';
import { denialOf } from '../decoders/denials.js';
import { DenialRow } from './denial-row.js';

/** Renderer key registered into the keyed `conversation.chat.node` slot. */
export const DENIAL_NODE_KIND = 'arbiter-denial';

/** The row payload the renderer receives; locale-neutral and already bounded. */
export interface SessionDenialData {
  readonly callId: string;
  readonly tool: string;
  readonly denial: NonNullable<ReturnType<typeof denialOf>>;
}

/** One published Chat node for this row. */
export interface SessionDenialNode {
  readonly key: string;
  readonly kind: string;
  readonly id: string;
  readonly target: string;
  readonly anchorSeq: number;
  /** The engine's own Turn/Step placement, so the row folds with its Turn. */
  readonly location: ConversationLocationPort;
  readonly visibility: 'visible';
  readonly data: SessionDenialData;
}

/**
 * Read one nested field bag.
 *
 * The event payload is untrusted JSON from the session log, so every level is
 * narrowed here instead of being asserted into a shape it may not have.
 */
function recordOf(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null) return null;
  return { ...value };
}

/** Read the call identity and denial fact out of one `tool/result`. */
function denialFactsOf(event: unknown): SessionDenialData | null {
  const outer = recordOf(event);
  if (outer === null || outer['type'] !== 'tool/result') return null;
  const data = recordOf(outer['data']);
  if (data === null) return null;
  const denial = denialOf(data['error']);
  if (denial === null) return null;
  const source = recordOf(recordOf(data['message'])?.['source']);
  if (source === null) return null;
  const callId = source['callId'];
  if (typeof callId !== 'string' || callId === '') return null;
  const tool = typeof source['name'] === 'string' ? source['name'] : '';
  return { callId, tool, denial };
}

/** The seq this row sorts at; the result's own seq places it after its call. */
function seqOf(event: unknown): number | null {
  const outer = recordOf(event);
  if (outer === null) return null;
  const seq = outer['seq'];
  return typeof seq === 'number' && Number.isFinite(seq) ? seq : null;
}

/**
 * The conversation Definition contributed for one call's denial.
 *
 * `buildViewNode` anchors at the result's own seq, so a parallel call's row is
 * placed by its own result rather than by whichever denial arrived first.
 */
export const denialDefinition: ConversationDefinitionPort<
  SessionDenialData,
  SessionDenialNode
> = {
  kind: DENIAL_NODE_KIND,
  target: 'chat',
  match(event: unknown) {
    const facts = denialFactsOf(event);
    return facts === null ? null : { id: facts.callId, role: 'start' };
  },
  start(_context, match) {
    const facts = denialFactsOf(match.event);
    if (facts === null)
      throw new Error('arbiter-denial start requires an Arbiter tool/result');
    return facts;
  },
  update(context) {
    return context.state;
  },
  buildViewNode(context) {
    if (context.state === undefined || context.start === undefined) return null;
    const anchorSeq = seqOf(context.start.event);
    if (anchorSeq === null) return null;
    return {
      key: context.key,
      kind: DENIAL_NODE_KIND,
      id: context.id,
      target: 'chat',
      anchorSeq,
      // Carry the engine's placement through unchanged. Reporting `session`
      // here would detach the row from the Turn that issued the call, so Turn
      // folding could not reach it and it would outlive the collapsed process.
      location: context.start.location ?? { kind: 'unresolved' },
      visibility: 'visible',
      data: context.state,
    };
  },
};

/**
 * Build the row renderer for one plugin lifetime.
 *
 * The row reads its copy through the same host-bound dictionary as the rest of
 * the plugin UI, so the marker follows the host language and falls back to the
 * Chinese source per key.
 */
export function createDenialNodeView(
  i18n: ArbiterI18n,
): (props: {
  readonly node: { readonly data: SessionDenialData };
}) => ReactNode {
  return function DenialChatNode(props: {
    readonly node: { readonly data: SessionDenialData };
  }): ReactNode {
    return (
      <ArbiterI18nProvider i18n={i18n}>
        <DenialRow
          callId={props.node.data.callId}
          tool={props.node.data.tool}
          denial={props.node.data.denial}
        />
      </ArbiterI18nProvider>
    );
  };
}
