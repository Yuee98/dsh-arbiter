/** dsh-arbiter host entry. Decision, lifecycle and route adapters live in host/. */
import { registerCommands } from './host/commands.js';
import { CallGate } from './host/gate.js';
import { DecisionHistory } from './host/history.js';
import { PermissionLifecycle } from './host/permissions.js';
import { registerRoutes } from './host/routes.js';
import { initializeHost } from './host/runtime.js';
import { SessionAdmissions } from './host/session-admission.js';
import { CallSettlement } from './host/settlement.js';
import type { ContextLike, HostEnvironment } from './host/types.js';

export type { ContextLike } from './host/types.js';
export {
  AUTO_REJECTION_HINT,
  AutoEntryRejected,
  UNLOAD_DRAIN_MS,
} from './host/permissions.js';

export const name = 'arbiter';
export const inject = [
  'tools',
  'sessions',
  'llm',
  'approval',
  'permissionPresets',
  'workingDirectory',
];

/**
 * Apply the plugin and return the host it wired.
 *
 * The return value is the plugin's own environment object, exposed so a caller
 * that owns the lifecycle (a command, a teardown, an integration test) can reach
 * an operation such as an explicit history reset without rebuilding any of it.
 * The DSH loader ignores an `apply` return value, so this changes no host
 * behaviour.
 */
export function apply(ctx: ContextLike, rawConfig: unknown): HostEnvironment {
  const host = initializeHost(ctx, rawConfig);
  const history = new DecisionHistory(host);
  // One implementation of the explicit reset is reachable from the host, so a
  // lifecycle owner does not have to rebuild the selector to use it.
  host.history = history;
  const admissions = new SessionAdmissions(host);
  const permissions = new PermissionLifecycle(host, history, admissions);
  const settlement = new CallSettlement(host, history);
  // The boundary is applied to an enabled session; a configuration change must
  // reach the sessions the user already enabled, and nothing else.
  host.runtime.configListeners.add((config) => {
    admissions.syncBoundary(config);
  });
  // The startup activation already happened inside `initializeHost`, before
  // this listener existed. Reconcile once here as well: a profile that starts
  // with the master switch off must not leave a previously admitted session
  // holding the permission the plugin widened for it.
  admissions.syncBoundary(host.runtime.config);
  ctx.effect(
    () => () => {
      host.runtime.configListeners.clear();
    },
    'arbiter config listeners',
  );
  permissions.register();
  new CallGate(host, permissions, history, settlement).register();
  registerCommands(host);
  registerRoutes(host, admissions);
  const { runtime, audit } = host;
  ctx.logger.info(
    'arbiter: enabled=%s revision=%s rules=%s reviewer=%s audit=%s',
    String(runtime.config.enabled),
    runtime.effectiveRevision,
    String(runtime.config.rules.length),
    runtime.config.reviewer.type,
    audit === null ? 'unavailable' : 'ready',
  );
  return host;
}
