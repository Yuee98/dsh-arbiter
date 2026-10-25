export interface SessionHeaderLike {
  readonly id?: string;
  readonly cwd?: string;
  readonly parentSession?: string;
  readonly origin?: string;
  readonly delegationDepth?: number;
}

export interface SessionEventLike {
  readonly seq: number;
  readonly type: string;
  readonly time?: number;
  readonly data?: unknown;
  /**
   * Set by the host on plugin records written through `appendPluginRecord`.
   * A reader that does not know the type retains and skips the record instead
   * of refusing the whole log, which is why plugin state must carry it.
   */
  readonly ignorable?: boolean;
}

export interface SessionLike {
  readonly id?: string;
  readonly header?: SessionHeaderLike;
  snapshotEvents?(): readonly SessionEventLike[];
  deriveMessages?(): readonly unknown[];
  requestHeader?():
    | { readonly config: { readonly provider: string; readonly model: string } }
    | undefined;
  append?(type: string, data: unknown): unknown;
}

export interface AgentLike {
  readonly session: SessionLike;
}

export interface SessionsLike {
  get?(id: string): SessionLike | undefined;
  /** Every live session, in creation order (public `SessionStore.list`). */
  list?(): readonly SessionLike[];
}
