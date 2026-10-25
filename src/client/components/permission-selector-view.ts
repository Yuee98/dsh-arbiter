import type { Translate } from '../i18n.js';
import type {
  AdmissionFailure,
  AdmissionFailureCode,
  AdmissionState,
} from '../permission-selector-state.js';
import type { HostPermissionCatalogOption } from '../view-types.js';

/**
 * Which failure key an answer maps to.
 *
 * The mapping lives here rather than in the message text so a new backend code
 * cannot silently render a raw key: an unrecognized code falls back to the
 * generic request failure, which always exists.
 */
const FAILURE_KEYS: Readonly<Record<AdmissionFailureCode, string>> = {
  'session-required': 'permission.error.sessionRequired',
  'session-unknown': 'permission.error.sessionUnknown',
  'invalid-action': 'permission.error.invalidAction',
  'boundary-not-overridable': 'permission.error.boundaryNotOverridable',
  'boundary-unconfirmed': 'permission.error.boundaryUnconfirmed',
  'boundary-not-applied': 'permission.error.boundaryNotApplied',
  'record-unavailable': 'permission.error.recordUnavailable',
  'record-failed': 'permission.error.recordFailed',
  'plugin-disabled': 'permission.error.pluginDisabled',
  stopping: 'permission.error.stopping',
  'request-failed': 'permission.error.requestFailed',
  'host-unavailable': 'permission.error.hostUnavailableDetail',
};

/** One localized sentence; `detail` is used only where the copy names it. */
export function failureMessage(
  failure: AdmissionFailure,
  t: Translate,
): string {
  return t(FAILURE_KEYS[failure.code], { detail: failure.detail });
}

/** The boundary in the trigger, from the confirmed view only. */
export function boundaryLabel(
  state: AdmissionState,
  t: Translate,
): string | null {
  const view = state.confirmed;
  if (view === null || !view.enabled) return null;
  return view.boundary === 'trusted'
    ? t('permission.boundary.trusted')
    : t('permission.boundary.guarded');
}

/**
 * The trigger text.
 *
 * The enabled state always comes from the confirmed admission; a host preset is
 * shown only when the backend confirms the session is not admitted, and it is
 * the host's own current selection rather than anything derived from a sandbox
 * value. That keeps "admitted + guarded" and "not admitted + workspace-write"
 * distinguishable even though the host sandbox looks the same.
 */
export function triggerText(
  options: {
    readonly state: AdmissionState;
    readonly hostPreset: HostPermissionCatalogOption | null;
  },
  t: Translate,
): string {
  const boundary = boundaryLabel(options.state, t);
  if (boundary !== null) return t('permission.trigger.enabled', { boundary });
  if (options.state.confirmed === null) {
    // `session-unknown` means the host has not materialized this session yet;
    // that is "unavailable", never a confirmed "disabled".
    return options.state.failure?.code === 'session-unknown'
      ? t('permission.trigger.unavailable')
      : t('permission.loading');
  }
  if (options.hostPreset === null) return t('permission.trigger.hostUnknown');
  return t('permission.trigger.hostOnly', {
    preset: presetLabel(options.hostPreset, t),
  });
}

/**
 * The host's own labels for the presets this plugin ships with.
 *
 * A composition can answer the catalog with raw preset keys as both value and
 * name (the host's own selector localizes them client-side); showing `read-only`
 * to a Chinese user would be raw protocol text, not a label. A host-supplied
 * display name always wins, so a renamed preset is never overwritten.
 */
const PRESET_LABELS: Readonly<Record<string, string>> = {
  'read-only': 'permission.preset.readOnly',
  'workspace-write': 'permission.preset.workspaceWrite',
  'danger-full-access': 'permission.preset.fullAccess',
};

const PRESET_HINTS: Readonly<Record<string, string>> = {
  'read-only': 'permission.preset.readOnlyHint',
  'workspace-write': 'permission.preset.workspaceWriteHint',
  'danger-full-access': 'permission.preset.fullAccessHint',
};

/** One host preset's display name, localized only when it carries no name. */
export function presetLabel(
  option: HostPermissionCatalogOption,
  t: Translate,
): string {
  const key = PRESET_LABELS[option.value];
  if (key !== undefined && option.name === option.value) return t(key);
  return option.name;
}

/** One host preset's sentence; the host's own description wins when present. */
function presetHint(option: HostPermissionCatalogOption, t: Translate): string {
  if (option.description !== undefined) return option.description;
  const key = PRESET_HINTS[option.value];
  return key === undefined
    ? t('permission.option.hostHint', { preset: presetLabel(option, t) })
    : t(key);
}

/** Host options the selector offers: `auto` is rejected by #4, `custom` derives. */
export const UNSELECTABLE_PRESETS: ReadonlySet<string> = new Set([
  'auto',
  'custom',
]);

export interface SelectorItem {
  readonly id: string;
  readonly label: string;
  readonly hint: string;
  readonly current: boolean;
  readonly danger: boolean;
}

/** The arbiter entry's own id; a host preset may never collide with it. */
export const ARBITER_ITEM = '__arbiter';

/** The always-available exit, so a degraded bridge still has a disable path. */
export const DISABLE_ITEM = '__disable';

/**
 * The menu contents.
 *
 * The Arbiter entry comes first because it is this plugin's own surface. The
 * explicit disable entry follows: when the host catalog or command is
 * unavailable, the host presets cannot be offered, but leaving Arbiter must stay
 * possible. Host presets follow in catalog order; the host's current preset is
 * marked only when the catalog actually lists it, and an unlisted one keeps its
 * own display without being fabricated as an option.
 */
export function selectorItems(options: {
  readonly state: AdmissionState;
  readonly catalog: readonly HostPermissionCatalogOption[] | null;
  readonly hostPreset: HostPermissionCatalogOption | null;
  readonly t: Translate;
}): readonly SelectorItem[] {
  const { state, catalog, hostPreset, t } = options;
  const enabled = state.confirmed?.enabled === true;
  const arbiter: SelectorItem = {
    id: ARBITER_ITEM,
    label: t('permission.option.arbiter'),
    hint: t('permission.option.arbiterHint'),
    current: enabled,
    danger: false,
  };
  const disable: SelectorItem = {
    id: DISABLE_ITEM,
    label: t('permission.option.disable'),
    hint: t('permission.option.disableHint'),
    current: state.confirmed !== null && !enabled,
    danger: false,
  };
  const host = (catalog ?? [])
    .filter((option) => !UNSELECTABLE_PRESETS.has(option.value))
    .map((option) => ({
      id: option.value,
      label: presetLabel(option, t),
      hint: presetHint(option, t),
      current: !enabled && hostPreset?.value === option.value,
      danger: option.value === 'danger-full-access',
    }));
  return [arbiter, disable, ...host];
}
