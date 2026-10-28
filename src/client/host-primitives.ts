/**
 * The host's browser primitives, validated once at load.
 *
 * The permission selector must look exactly like the host's own control, so it
 * renders the host's `Menu` and `RiskConfirmation` instead of reimplementing
 * them. Those live in `@deepseek-ai/dsh-client-ui-primitives`, which is not an
 * npm dependency of this plugin: the web shell publishes it in the platform
 * seed table, and the module loader's `require` resolves it there.
 *
 * The import is static on purpose. esbuild hoists a static external to one
 * `require(...)` at the top of the factory, which keeps the dependency visible
 * in the bundle and in the packed-consumer check; a `try/catch` around it would
 * not survive, because the hoisted call runs during module evaluation, before
 * any component code could recover. Consequently there is no fallback UI: on
 * the pinned host the exports are a run-time prerequisite, and a missing export
 * must fail loudly here rather than as an unrelated React crash later.
 *
 * This module only checks shapes it is about to call; it never inspects props
 * or state, so it cannot become a second source of permission truth.
 */

import {
  IconChevronDownOutlineRegular,
  Menu,
  PermissionIconAutoReviewRegular,
  PermissionIconFullAccessRegular,
  PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular,
  RiskConfirmation,
} from '@deepseek-ai/dsh-client-ui-primitives';
function assertComponent(name: string, value: unknown): void {
  // React components are functions (or, from a lazy wrapper, objects); anything
  // falsy means the pinned host did not publish what this control renders.
  if (value === undefined || value === null) {
    throw new Error(
      `arbiter: the host did not publish "${name}" from @deepseek-ai/dsh-client-ui-primitives`,
    );
  }
}

assertComponent('Menu', Menu);
assertComponent('RiskConfirmation', RiskConfirmation);
assertComponent('PermissionIconReadOnlyRegular', PermissionIconReadOnlyRegular);
assertComponent(
  'PermissionIconWorkspaceWriteRegular',
  PermissionIconWorkspaceWriteRegular,
);
assertComponent(
  'PermissionIconFullAccessRegular',
  PermissionIconFullAccessRegular,
);
assertComponent(
  'PermissionIconAutoReviewRegular',
  PermissionIconAutoReviewRegular,
);
assertComponent('IconChevronDownOutlineRegular', IconChevronDownOutlineRegular);

/** The host surfaces this plugin renders, already shape-checked above. */
export const hostPrimitives = {
  Menu,
  RiskConfirmation,
  IconChevronDownOutlineRegular,
  PermissionIconReadOnlyRegular,
  PermissionIconWorkspaceWriteRegular,
  PermissionIconFullAccessRegular,
  PermissionIconAutoReviewRegular,
} as const;
