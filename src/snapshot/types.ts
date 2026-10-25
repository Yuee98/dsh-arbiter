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
}
