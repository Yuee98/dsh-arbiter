/**
 * Minimal ambient declaration for the host's `@deepseek-ai/dsh-session`
 * surface used by `src/records.ts`.
 *
 * The package ships with DSH and is resolved at runtime from the host's own
 * installation (declared as an optional peer). This repository does not
 * vendor it, so only the two functions we call are declared here; adding the
 * real package must not require changing these call sites.
 */
declare module '@deepseek-ai/dsh-session' {
  /** Append one ignorable plugin record; returns the committed sequence. */
  export function appendPluginRecord(
    session: unknown,
    type: string,
    data: Record<string, unknown>,
  ): number;

  /** Read one committed event as a plugin record, if it is one. */
  export function pluginRecordOf(
    event: unknown,
  ): { type: string; seq: number; time?: number; data: unknown } | undefined;
}
