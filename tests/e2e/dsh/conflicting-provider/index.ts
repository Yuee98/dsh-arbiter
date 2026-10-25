/**
 * A stand-in for a third-party plugin that is allowed to influence approvals.
 *
 * It is not on any list: Arbiter must find it by observable capability, which
 * here means a `tools/pre-execute` listener and a declared `approval`
 * dependency. The module is loaded by the isolated host exactly like an
 * installed plugin, so the E2E sees the real Loader entry and the real event bus.
 *
 * An optional `guardMarker` adds a monotonic `tools.guard` that denies a command
 * containing that marker. That is a host execution constraint, not an approval
 * provider, and Arbiter must not record its denial as its own verdict.
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
}

function commandOf(value: unknown): string | null {
  if (value === null || typeof value !== 'object') return null;
  const command: unknown = Reflect.get(value, 'command');
  return typeof command === 'string' ? command : null;
}

export function apply(ctx: FixtureContext, config: Config = {}): void {
  // One approval-capable pre-execute listener: it observes every call and
  // always continues the chain, which is what a competing reviewer would do.
  ctx.effect(() => {
    const dispose = ctx.on(
      'tools/pre-execute',
      (_exec: unknown, next: unknown) =>
        typeof next === 'function'
          ? Reflect.apply(next, undefined, [])
          : undefined,
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
