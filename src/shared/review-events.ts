/** Source facts shared by the host adapter, workflow evals and stored snapshots. */
export interface ReviewEventIdentity {
  readonly eventId: string;
  readonly sessionId: string;
  readonly seq: number;
  readonly turnId: string | null;
  readonly time?: number;
  /** A logical message may occur in more than one distinct log event. */
  readonly messageId?: string;
  readonly protected?: boolean;
}

export interface ReviewMedia {
  readonly type: string;
  readonly ref?: string;
  readonly note: string;
}

export type ReviewResultBody =
  | {
      readonly state: 'present';
      readonly content: unknown;
      readonly truncations?: readonly {
        readonly source: 'upstream' | 'collection';
        readonly note: string;
      }[];
    }
  | { readonly state: 'empty' }
  | {
      readonly state: 'unavailable';
      readonly reason: 'not-provided' | 'unreadable' | 'lost';
    }
  | { readonly state: 'omitted'; readonly media: readonly ReviewMedia[] };

export interface ReviewAnswerBinding {
  readonly askId: string;
  readonly questionEventId?: string;
  /** Question text supplied by the host in the answer event itself. */
  readonly question?: string;
  readonly answerIds?: readonly string[];
  readonly status: 'bound' | 'unavailable';
}

export type ReviewEvent = ReviewEventIdentity &
  (
    | {
        readonly kind: 'human';
        readonly source: 'session-human' | 'parent-human';
        readonly text: string;
        readonly binding?: ReviewAnswerBinding;
      }
    | {
        readonly kind: 'relay';
        readonly source: 'parent-relay';
        readonly senderSessionId: string;
        readonly text: string;
      }
    | {
        readonly kind: 'assistant' | 'checkpoint';
        readonly text: string;
      }
    | {
        readonly kind: 'question';
        readonly askId: string;
        readonly questionIds?: readonly string[];
        readonly text: string;
        readonly callId?: string;
      }
    | {
        readonly kind: 'call';
        readonly callId: string;
        readonly tool: string;
        readonly arguments: unknown;
        readonly cwd?: string;
      }
    | {
        readonly kind: 'settlement';
        readonly callId: string;
        readonly outcome: 'allowed' | 'denied' | 'aborted' | 'failed';
      }
    | {
        readonly kind: 'result';
        readonly callId: string;
        readonly status: 'success' | 'failure' | 'unknown';
        readonly body: ReviewResultBody;
        readonly exitCode?: number;
        readonly callUnavailable?: 'not-observed';
        /** Missing call information is explicit, never reconstructed from text. */
        readonly call?: {
          readonly eventId: string;
          readonly tool: string;
          readonly cwd?: string;
        };
      }
  );

export interface ReviewSourceStatus {
  readonly sessionId: string;
  readonly status: 'complete' | 'known-empty' | 'unavailable' | 'stopped';
  readonly cutoff: { readonly eventId: string; readonly seq: number } | null;
  readonly fromSeq: number | null;
  readonly reason: string | null;
  /** Whether a host range was used, or a structural host returned a full array. */
  readonly access: 'range' | 'snapshot' | 'declared';
  readonly protectedOriginalMissing?: string;
  /** Known source state survives omission of the lossy summary body. */
  readonly compacted?: boolean;
}

export interface ReviewEventSource {
  readonly status: ReviewSourceStatus;
  readonly events: readonly ReviewEvent[];
}

export interface ReviewEventSources {
  readonly local: ReviewEventSource;
  readonly parent: ReviewEventSource | null;
}

export interface ReviewPrefix extends ReviewEventSources {
  readonly omissions: readonly {
    readonly sessionId: string;
    readonly cause: 'read' | 'budget';
    readonly reason: string;
    /** Only counted observed events; never an estimate of unread history. */
    readonly count?: number;
  }[];
}
