import type { Translate } from '../i18n.js';
import type {
  AdmissionFailure,
  AdmissionFailureCode,
  AdmissionState,
} from '../permission-selector-state.js';
import type {
  HostPermissionCatalogOption,
  HostPresetSelection,
} from '../view-types.js';
import { isUnavailable } from '../permission-selector-state.js';

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
  'command-not-applied': 'permission.error.commandNotApplied',
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
 * The host's own labels for the presets it ships with.
 *
 * The host catalog answers a preset's *machine value* as its `name` unless the
 * deployment renamed it, so the surface must localize the built-in three itself
 * — exactly as the host's own selector does. Keeping the host's Chinese wording
 * (`仅可查看` rather than the plugin's older `只读`) is part of native parity.
 */
const PRESET_LABEL_KEYS: Readonly<Record<string, string>> = {
  'read-only': 'permission.preset.readOnly',
  'workspace-write': 'permission.preset.workspaceWrite',
  'danger-full-access': 'permission.preset.fullAccess',
};

/**
 * The English labels the host compares against its own defaults.
 *
 * A host preset whose `name` still equals its English default label has not
 * been renamed, so the localized built-in label replaces it. Any other name is
 * the deployment's or the preset's own identity and is displayed as given.
 */
const PRESET_ENGLISH_LABELS: Readonly<Record<string, string>> = {
  'read-only': 'Read Only',
  'workspace-write': 'Workspace Write',
  'danger-full-access': 'Full access',
};

/** The host's own conventional-name rule: kebab case becomes title case. */
const CONVENTIONAL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/**
 * Display one host-supplied name.
 *
 * Mirrors the host's presentation rule so a renamed preset looks identical in
 * both controls: conventional kebab-case names are title-cased, anything else
 * (a sentence, a non-ASCII label) is shown unchanged.
 */
export function displayPresetName(name: string): string {
  if (!CONVENTIONAL_NAME.test(name)) return name;
  return name
    .split('-')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * One host preset's display label.
 *
 * A built-in preset still carrying its own key (or the host's English default)
 * is localized here; a deployment that renamed it keeps the new name.
 */
export function presetLabel(
  option: HostPermissionCatalogOption,
  t: Translate,
): string {
  const key = PRESET_LABEL_KEYS[option.value];
  if (key !== undefined) {
    const english = PRESET_ENGLISH_LABELS[option.value];
    if (option.name === option.value || option.name === english) {
      return t(key);
    }
  }
  return displayPresetName(option.name);
}

/** The label for a preset the catalog does not list, from its raw value. */
function unlistedPresetLabel(value: string, t: Translate): string {
  const key = PRESET_LABEL_KEYS[value];
  return key === undefined ? displayPresetName(value) : t(key);
}

/** The three strings one trigger needs: visible, tooltip and accessible name. */
export interface TriggerTexts {
  readonly label: string;
  /** The boundary, or `null` when Arbiter is not the confirmed state. */
  readonly boundary: string | null;
  readonly title: string;
  readonly ariaLabel: string;
}

/**
 * Everything the trigger says, from the confirmed view only.
 *
 * The visible label is deliberately the native one: the host preset name while
 * Arbiter is off, and `自动审查（Arbiter）` while it is on. The execution
 * boundary never widens that label — it rides the tooltip and the accessible
 * name, so the control keeps the host's single-line geometry.
 */
export function triggerTexts(
  options: {
    readonly state: AdmissionState;
    /** The host's current preset, including a value the catalog omits. */
    readonly hostPreset: HostPresetSelection | null;
    readonly catalog: readonly HostPermissionCatalogOption[] | null;
    readonly failure: string | null;
  },
  t: Translate,
): TriggerTexts {
  const { state, hostPreset, catalog, failure } = options;
  // Unavailable wins over the retained confirmation: the host cannot address
  // this session, so the old enabled label must not look current.
  if (isUnavailable(state)) {
    const label = t('permission.trigger.unavailable');
    return { label, boundary: null, title: failure ?? label, ariaLabel: label };
  }
  const boundary = boundaryLabel(state, t);
  if (boundary !== null) {
    const label = t('permission.trigger.enabled');
    return {
      label,
      boundary,
      title: `${label} · ${boundary}`,
      ariaLabel: t('permission.trigger.open', {
        current: `${label} · ${boundary}`,
      }),
    };
  }
  if (state.confirmed === null) {
    // Still loading: the visible text says so, while the accessible name keeps
    // the control's stable identity ("open the permission menu").
    const label = t('permission.loading');
    return {
      label,
      boundary: null,
      title: label,
      ariaLabel: t('permission.trigger.open', { current: label }),
    };
  }
  const listed =
    catalog?.find((option) => option.value === hostPreset?.currentValue) ??
    null;
  // A host value the catalog omits (`custom`, or a preset removed since the page
  // loaded) keeps its own identity instead of pretending the session has none.
  const label =
    hostPreset === null
      ? t('permission.trigger.hostUnknown')
      : listed === null
        ? unlistedPresetLabel(hostPreset.currentValue, t)
        : presetLabel(listed, t);
  return {
    label,
    boundary: null,
    title: failure ?? label,
    ariaLabel: t('permission.trigger.open', { current: label }),
  };
}

/** Host options the selector offers: `auto` is rejected by the host half. */
export const UNSELECTABLE_PRESETS: ReadonlySet<string> = new Set([
  'auto',
  'custom',
]);

/** The host surface a row's glyph comes from; the component maps it to one. */
export type PresetIconKind =
  'read-only' | 'workspace-write' | 'danger-full-access' | 'arbiter';

export interface SelectorItem {
  readonly id: string;
  readonly label: string;
  /** `null` for a deployment-defined preset the host design set has no glyph for. */
  readonly icon: PresetIconKind | null;
  /** The row the host menu draws as selected. */
  readonly current: boolean;
  readonly danger: boolean;
  /** A host preset is disabled when the command surface cannot apply it. */
  readonly disabled: boolean;
}

/** The arbiter entry's own id; a host preset may never collide with it. */
export const ARBITER_ITEM = '__arbiter';

/** The degraded-state exit, only offered when the host cannot switch at all. */
export const DISABLE_ITEM = '__disable';

/** Which row is drawn as selected: never a host preset while Arbiter is on. */
export function selectedItemId(options: {
  readonly state: AdmissionState;
  readonly hostPreset: HostPresetSelection | null;
}): string | undefined {
  const confirmed = options.state.confirmed;
  if (confirmed === null) return undefined;
  if (confirmed.enabled) return ARBITER_ITEM;
  return options.hostPreset?.currentValue;
}

/**
 * The menu contents.
 *
 * Host presets come first in the host's own catalog order, so the list reads
 * exactly like the native menu; Arbiter is appended last, the position the host
 * gives its own experimental entry. Nothing carries a second line of copy — the
 * host menu has no room for one, and a user who enabled the plugin knows what
 * it does.
 *
 * The degraded exit is not a normal option: it appears only when Arbiter is
 * confirmed enabled and the host cannot switch presets at all (no readable
 * catalog, or a bound session with no callable command), which is the one state
 * where the presets above it cannot be used to leave.
 */
export function selectorItems(options: {
  readonly state: AdmissionState;
  readonly catalog: readonly HostPermissionCatalogOption[] | null;
  /** Whether the host command surface can apply a preset for this session. */
  readonly commandCapable: boolean;
  /** The row to draw as selected; `undefined` while admission is unknown. */
  readonly selectedId: string | undefined;
  readonly t: Translate;
}): readonly SelectorItem[] {
  const { state, catalog, commandCapable, selectedId, t } = options;
  const enabled = state.confirmed?.enabled === true;
  const host = (catalog ?? [])
    .filter((option) => !UNSELECTABLE_PRESETS.has(option.value))
    .map((option) => ({
      id: option.value,
      label: presetLabel(option, t),
      icon: iconOf(option.value),
      current: selectedId === option.value,
      danger: option.value === 'danger-full-access',
      disabled: !commandCapable,
    }));
  const arbiter: SelectorItem = {
    id: ARBITER_ITEM,
    label: t('permission.option.arbiter'),
    icon: 'arbiter',
    current: selectedId === ARBITER_ITEM,
    danger: false,
    disabled: false,
  };
  const degraded = enabled && (catalog === null || !commandCapable);
  const disable: SelectorItem = {
    id: DISABLE_ITEM,
    label: t('permission.option.disable'),
    icon: 'arbiter',
    current: false,
    danger: false,
    disabled: false,
  };
  return [...host, arbiter, ...(degraded ? [disable] : [])];
}

/** The glyph for one preset value; unknown deployment presets get none. */
function iconOf(value: string): PresetIconKind | null {
  switch (value) {
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return value;
    default:
      // A deployment-defined preset has no glyph in the host's design set, and
      // borrowing another preset's icon would misdescribe it.
      return null;
  }
}
