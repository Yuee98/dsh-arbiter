/**
 * A stand-in for a third-party plugin that is allowed to influence approvals.
 *
 * It is not on any list: Arbiter must find it by observable capability, which
 * here means a `tools/pre-execute` listener and a declared `approval`
 * dependency. The module is loaded by the isolated host exactly like an
 * installed plugin, so the E2E sees the real Loader entry and the real event bus.
 *
 * Two optional behaviours let one fixture cover the provenance boundaries:
 *   - `guardMarker` adds a monotonic `tools.guard` denying a command containing
 *     it. That is a host execution constraint, registered in the host's own
 *     guard list rather than the event waterfall.
 *   - `denyMarker` returns a `deny` decision from the listener itself, which is
 *     another plugin's own approval verdict, dispatched before Arbiter sees the
 *     call. Arbiter must not record it as its verdict.
 */

export const name = 'arbiter-e2e-conflicting-provider';
export const inject = ['approval', 'tools'];

/** The narrow host surface this fixture needs, as the isolated host provides it. */
interface FixtureContext {
  readonly tools: {
    guard(
      check: (exec: { readonly arguments: unknown }) => string | undefined,
    ): () => void;
  };
  effect(callback: () => () => void, label: string): void;
  on(
    event: string,
    listener: (...args: unknown[]) => unknown,
  ): () => boolean | undefined;
}

interface Config {
  readonly guardMarker?: unknown;
  readonly denyMarker?: unknown;
}

function commandOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const command: unknown = Reflect.get(value, 'command');
  return typeof command === 'string' ? command : null;
}

function markerOf(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function decide(
  exec: unknown,
  next: unknown,
  denyMarker: string | null,
): unknown {
  const command =
    exec === null || typeof exec !== 'object'
      ? null
      : commandOf(Reflect.get(exec, 'arguments'));
  if (command !== null && denyMarker !== null && command.includes(denyMarker)) {
    // This plugin's own verdict: the host records the call as refused before
    // Arbiter's listener is reached, so no Arbiter decision may appear.
    return {
      kind: 'deny',
      reason: 'conflicting provider denied this call',
    };
  }
  // Everything else continues the chain, which is what an observing provider
  // does: participation without a verdict.
  return typeof next === 'function'
    ? Reflect.apply(next, undefined, [])
    : undefined;
}

export function apply(ctx: FixtureContext, config: Config = {}): void {
  const denyMarker = markerOf(config.denyMarker);
  // One approval-capable pre-execute listener, prepended so it runs before
  // Arbiter's gate — the same position a competing reviewer would take.
  ctx.effect(() => {
    const dispose = ctx.on(
      'tools/pre-execute',
      (exec: unknown, next: unknown) => decide(exec, next, denyMarker),
    );
    return () => {
      dispose();
    };
  }, 'conflicting-provider listener');

  const marker = config.guardMarker;
  if (typeof marker !== 'string' || marker.length === 0) return;
  ctx.effect(
    () =>
      ctx.tools.guard((exec) => {
        // `exec.arguments` is the tool's already-parsed input object.
        const command = commandOf(exec.arguments);
        if (command === null) return undefined;
        return command.includes(marker)
          ? 'conflicting provider guard: this command is blocked by the test guard'
          : undefined;
      }),
    'conflicting-provider guard',
  );
}
