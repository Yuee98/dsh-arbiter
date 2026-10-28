import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import { hostPrimitives } from '../host-primitives.js';
import { useAdmission } from '../permission-selector-model.js';
import { isInteractive } from '../permission-selector-state.js';
import {
  ARBITER_ITEM,
  DISABLE_ITEM,
  failureMessage,
  selectedItemId,
  selectorItems,
  triggerTexts,
} from './permission-selector-view.js';
import type {
  PresetIconKind,
  SelectorItem,
} from './permission-selector-view.js';
import type { HostBridge } from '../view-types.js';

/** Single slots render the lowest priority first; the host's native seat is 0. */
export const PERMISSION_SLOT_PRIORITY = -1;

/**
 * The Arbiter session permission selector.
 *
 * It occupies the host's own composer permission seat and renders the host's
 * real `Menu` and `RiskConfirmation`, so the control looks and behaves like the
 * native one. The menu is the host catalog in the host's order plus a single
 * appended `自动审查（Arbiter）` entry; nothing carries a subtitle.
 *
 * Two authorities stay separate: admission ("is Arbiter enabled") is the last
 * answer this plugin's own route confirmed, and the host preset is read from the
 * session's `permissions` projection. Nothing infers one from the other.
 *
 * One behaviour deliberately differs from the native control. Its `choose()`
 * returns early when the clicked preset equals the host's derived current value;
 * under Arbiter + guarded that value already *is* `workspace-write`, so the same
 * early return would turn "pick 工作区内修改 to leave Arbiter" into a silent no-op.
 * A same-value selection therefore still sends `/permission <preset>` — but only
 * while Arbiter is confirmed enabled. When it is not, the native no-op is
 * preserved: there is nothing to leave, and inventing a command would add a
 * permission event pair the native control never emits.
 */
export function PermissionSelector(props: {
  readonly sessionId?: string | undefined;
  readonly locked?: boolean | undefined;
  readonly bridge?: HostBridge | undefined;
}): ReactNode {
  const t = useArbiterTranslation();
  const admission = useAdmission({
    sessionId: props.sessionId,
    bridge: props.bridge,
    enabled: true,
  });
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [acknowledged, setAcknowledged] = useState(false);

  const commandCapable =
    props.sessionId === undefined
      ? false
      : (props.bridge?.canCommand(props.sessionId) ?? false);
  const selectedId = selectedItemId({
    state: admission.state,
    hostPreset: admission.hostPreset,
  });
  const items = selectorItems({
    state: admission.state,
    catalog: admission.catalog,
    commandCapable,
    selectedId,
    t,
  });
  const interactive = isInteractive(admission.state, {
    locked: props.locked === true,
    sessionId: props.sessionId ?? null,
  });
  const failure =
    admission.state.failure === null
      ? null
      : failureMessage(admission.state.failure, t);
  const texts = triggerTexts(
    {
      state: admission.state,
      hostPreset: admission.hostPreset,
      catalog: admission.catalog,
      failure,
    },
    t,
  );

  useEffect(() => {
    if (!open && confirming === null) return;
    if (interactive) return;
    setOpen(false);
    setConfirming(null);
    setAcknowledged(false);
  }, [confirming, interactive, open]);

  /**
   * Apply one selection.
   *
   * Order matters: the native no-op is decided *before* the danger
   * confirmation, because re-picking the preset the host already applies must
   * not pop a risk dialog. The Arbiter and degraded-disable entries are handled
   * first, so their ids never reach the host command.
   */
  const choose = (id: string): void => {
    setOpen(false);
    if (id === ARBITER_ITEM) {
      // Already enabled: a second enable would only write a duplicate
      // admission record and change nothing.
      if (admission.state.confirmed?.enabled === true) return;
      admission.setEnabled(true).catch(() => undefined);
      return;
    }
    if (id === DISABLE_ITEM) {
      admission.setEnabled(false).catch(() => undefined);
      return;
    }
    const sameAsNative = id === admission.hostPreset?.currentValue;
    if (admission.state.confirmed?.enabled === false && sameAsNative) return;
    const danger = id === 'danger-full-access';
    if (danger) {
      setAcknowledged(false);
      setConfirming(id);
      return;
    }
    admission.chooseHostPreset(id).catch(() => undefined);
  };

  const item = items.find((entry) => entry.id === confirming) ?? null;

  return (
    <span
      data-arbiter-permission=""
      data-arbiter-surface="permission-selector"
      className="arb:relative arb:inline-flex arb:items-center arb:gap-1.5"
    >
      <hostPrimitives.Menu
        open={open}
        side="top"
        portal
        selectedId={selectedId}
        items={items.map(toHostItem)}
        onSelect={choose}
        onClose={() => {
          setOpen(false);
        }}
        anchor={
          <Trigger
            label={texts.label}
            title={texts.title}
            // The accessible name never takes over the pending state: the
            // control keeps its last confirmed identity while a write runs and
            // reports the wait through `aria-busy` alone.
            ariaLabel={texts.ariaLabel}
            busy={admission.state.pending}
            disabled={!interactive && !open}
            open={open}
            preset={selectedId ?? null}
            boundary={texts.boundary}
            onClick={() => {
              setOpen(!open);
            }}
          />
        }
      />
      {item === null ? null : (
        <hostPrimitives.RiskConfirmation
          open
          title={t('permission.confirm.title')}
          description={t('permission.confirm.description')}
          acknowledgeLabel={t('permission.confirm.acknowledge')}
          cancelLabel={t('permission.confirm.cancel')}
          closeLabel={t('permission.confirm.close')}
          confirmLabel={t('permission.confirm.enable')}
          acknowledged={acknowledged}
          disabled={!interactive}
          onAcknowledgedChange={setAcknowledged}
          onCancel={() => {
            setConfirming(null);
            setAcknowledged(false);
          }}
          onConfirm={() => {
            const preset = item.id;
            setConfirming(null);
            setAcknowledged(false);
            admission.chooseHostPreset(preset).catch(() => undefined);
          }}
        />
      )}
      <span
        role="status"
        aria-live="polite"
        className={`arb:max-w-[260px] arb:text-[11.5px] ${
          failure === null ? 'arb:text-tertiary' : 'arb:text-error'
        }`}
      >
        {failure ?? ''}
      </span>
    </span>
  );
}

/** One selector row in the host menu's currency. */
function toHostItem(item: SelectorItem): {
  readonly id: string;
  readonly label: string;
  readonly icon?: ReactNode;
  readonly danger?: boolean;
  readonly disabled?: boolean;
} {
  const icon = glyph(item.icon);
  return {
    id: item.id,
    label: item.label,
    ...(icon === null ? {} : { icon }),
    ...(item.danger ? { danger: true } : {}),
    ...(item.disabled ? { disabled: true } : {}),
  };
}

/** The host's own glyph for one preset family; `null` means none. */
function glyph(kind: PresetIconKind | null): ReactNode {
  switch (kind) {
    case 'read-only':
      return <hostPrimitives.PermissionIconReadOnlyRegular />;
    case 'workspace-write':
      return <hostPrimitives.PermissionIconWorkspaceWriteRegular />;
    case 'danger-full-access':
      return <hostPrimitives.PermissionIconFullAccessRegular />;
    case 'arbiter':
      return <hostPrimitives.PermissionIconAutoReviewRegular />;
    case null:
      return null;
  }
}

/**
 * The trigger.
 *
 * `Menu` renders its caller's `anchor` verbatim and does not style it, so the
 * native trigger geometry is reproduced here from the pinned host's structure
 * and design tokens: a 28px row with the preset glyph, a single truncating
 * label and a chevron that turns while the menu is open. The class names are
 * the plugin's own `arb:` utilities; the values (height, radius, hover and focus
 * colours) come from the host's public `--dsw-*` variables.
 */
function Trigger(props: {
  readonly label: string;
  readonly title: string;
  readonly ariaLabel: string;
  readonly busy: boolean;
  readonly disabled: boolean;
  readonly open: boolean;
  readonly preset: string | null;
  readonly boundary: string | null;
  readonly onClick: () => void;
}): ReactNode {
  return (
    <button
      type="button"
      data-arbiter-trigger=""
      aria-haspopup="menu"
      aria-expanded={props.open}
      aria-busy={props.busy}
      aria-label={props.ariaLabel}
      title={props.title}
      disabled={props.disabled}
      onClick={props.onClick}
      className="arb:inline-flex arb:h-7 arb:max-w-[220px] arb:cursor-pointer arb:items-center arb:gap-1 arb:rounded-sm arb:border-0 arb:bg-transparent arb:py-0 arb:pr-1 arb:pl-2 arb:text-[13px] arb:font-medium arb:leading-5 arb:text-secondary arb:hover:bg-[var(--dsw-alias-interactive-bg-hover)] arb:focus-visible:outline-none arb:focus-visible:ring-2 arb:focus-visible:ring-[var(--dsw-focus-ring-color,var(--arb-accent))] arb:disabled:cursor-default arb:disabled:text-[var(--dsw-alias-label-dimmed)]"
    >
      <span className="arb:inline-flex arb:shrink-0" aria-hidden="true">
        {glyph(presetKindOf(props.preset))}
      </span>
      <span className="arb:truncate arb:whitespace-nowrap">{props.label}</span>
      <span
        aria-hidden="true"
        className={`arb:inline-flex arb:shrink-0 arb:text-[var(--dsw-alias-label-caption)] arb:transition-transform ${
          props.open ? 'arb:rotate-180' : ''
        }`}
      >
        <hostPrimitives.IconChevronDownOutlineRegular />
      </span>
    </button>
  );
}

/** Which glyph the trigger shows: Arbiter's own, else the selected preset's. */
function presetKindOf(preset: string | null): PresetIconKind | null {
  switch (preset) {
    case null:
      return null;
    case 'read-only':
    case 'workspace-write':
    case 'danger-full-access':
      return preset;
    case ARBITER_ITEM:
      return 'arbiter';
    default:
      return null;
  }
}
