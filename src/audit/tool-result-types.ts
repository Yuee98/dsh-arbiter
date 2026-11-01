/** Post-execution observations are independent of immutable review snapshots. */
export type ToolResultStatus = 'success' | 'failure' | 'unknown';
export type ToolContentState =
  'available' | 'empty' | 'no-result' | 'unsupported' | 'unavailable';
export type ToolResultPart = {
  readonly channel: string;
  readonly source?: string;
} & (
  | {
      readonly kind: 'text';
      readonly text: string;
      readonly continuation?: boolean;
    }
  | { readonly kind: 'json'; readonly value: unknown }
  | {
      readonly kind: 'media';
      readonly mediaType: string;
      readonly reference?: string;
    }
);
export interface ToolResultObservation {
  readonly sessionId: string;
  readonly callId: string;
  readonly parentSession?: string | null;
  readonly observedAt: number;
  readonly callStartedAt?: number;
  readonly status: ToolResultStatus;
  readonly contentState: ToolContentState;
  readonly unavailableReason?: string;
  readonly upstreamTruncated?: boolean;
  readonly eventId?: string;
  readonly seq?: number;
  readonly turnId?: string;
  readonly invocation?: {
    readonly tool: string;
    readonly cwd?: string;
    readonly arguments?: unknown;
  };
  readonly parts: readonly ToolResultPart[];
  /** Capture before asynchronous observation work to fence a subsequent clear. */
  readonly generation?: string;
}
export interface ToolResultReceipt {
  readonly sessionId: string;
  readonly callId: string;
  readonly resultId: string;
}
export type ToolResultLookup = [
  sessionId: string,
  callId: string,
  expected?: ToolResultReceipt,
];
export interface ToolBodyFragment {
  /** Half-open byte range in the complete, redacted serialized source body. */
  readonly start: number;
  readonly end: number;
  readonly text: string;
}
export interface ToolResultMetadata {
  readonly version: 1;
  readonly processingVersion: 'tool-result-v1';
  readonly status: ToolResultStatus;
  readonly contentState: ToolContentState;
  readonly observedAt: number;
  readonly callStartedAt: number | null;
  readonly unavailableReason: string | null;
  readonly upstreamTruncated: boolean;
  readonly localTruncation: 'collection-limit' | null;
  readonly sourceBytes: number;
  readonly retainedBytes: number;
  readonly sha256: string;
  readonly ranges: readonly { readonly start: number; readonly end: number }[];
  readonly parts: readonly {
    readonly channel: string;
    readonly source: string | null;
    readonly kind: ToolResultPart['kind'];
    readonly start: number;
    readonly bytes: number;
    readonly mediaType: string | null;
    readonly reference: string | null;
  }[];
  /** Safe source descriptors, never inferred from insertion order. */
  readonly origin: unknown;
}
export interface ToolResultRead {
  readonly state:
    | 'found'
    | 'absent'
    | 'cleared'
    | 'unavailable'
    | 'storage-failed'
    | 'missing-file'
    | 'unreadable';
  readonly receipt: ToolResultReceipt | null;
  readonly metadata: ToolResultMetadata | null;
  readonly storage: 'inline' | 'file' | 'none' | 'failed' | null;
  readonly fileRef: string | null;
  readonly failure: string | null;
  /** Separate fragments; omitted source bytes are never presented as adjacent. */
  readonly fragments: readonly ToolBodyFragment[];
}
export interface ToolResultSave {
  readonly state:
    | 'saved'
    | 'already-recorded'
    | 'failed'
    | 'stale'
    | 'expired'
    | 'unavailable';
  readonly receipt: ToolResultReceipt | null;
  readonly equivalence: 'unverified' | null;
  readonly reason: string | null;
}
export interface ToolResultRecovery {
  readonly ok: boolean;
  readonly removed: number;
  readonly cleanupPending: boolean;
}
