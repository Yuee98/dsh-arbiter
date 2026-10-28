import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import { useAdmission } from '../permission-selector-model.js';
import { isInteractive } from '../permission-selector-state.js';
import {
  ARBITER_ITEM,
  DISABLE_ITEM,
  failureMessage,
  selectorItems,
  triggerText,
} from './permission-selector-view.js';
import type { HostBridge } from '../view-types.js';

/** Single slots render the lowest priority first; the host's native seat is 0. */
export const PERMISSION_SLOT_PRIORITY = -1;

/**
 * The Arbiter session permission selector.
 *
 * It occupies the host's own composer permission seat and shows the
 * backend-confirmed admission of the current session. The menu keeps the
 * host's permission presets: choosing one leaves Arbiter through the host's
 * `/permission <preset>` command, which is the only way the native control
 * would do it either. Nothing here infers "admitted" from a preset value, and
 * no state is optimistically advanced: the displayed value is always the last
 * answer the backend confirmed.
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
  const trigger = useRef<HTMLButtonElement | null>(null);
  const menuId = useId();

  const items = selectorItems({
    state: admission.state,
    catalog: admission.catalog,
    hostPreset:
      admission.catalog?.find(
        (option) => option.value === admission.hostPreset?.currentValue,
      ) ?? null,
    t,
  });
  const interactive = isInteractive(admission.state, {
    locked: props.locked === true,
    sessionId: props.sessionId ?? null,
  });
  const label = triggerText(
    {
      state: admission.state,
      hostPreset: admission.hostPreset,
      catalog: admission.catalog,
    },
    t,
  );
  const failure =
    admission.state.failure === null
      ? null
      : failureMessage(admission.state.failure, t);

  useEffect(() => {
    if (!open && confirming === null) return;
    if (interactive) return;
    setOpen(false);
    setConfirming(null);
    setAcknowledged(false);
  }, [confirming, interactive, open]);

  const close = (): void => {
    setOpen(false);
    setConfirming(null);
    setAcknowledged(false);
    trigger.current?.focus();
  };

  const choose = async (id: string, danger: boolean): Promise<void> => {
    setOpen(false);
    if (id === ARBITER_ITEM) {
      await admission.setEnabled(true);
      return;
    }
    if (id === DISABLE_ITEM) {
      await admission.setEnabled(false);
      return;
    }
    if (danger) {
      setAcknowledged(false);
      setConfirming(id);
      return;
    }
    await admission.chooseHostPreset(id);
  };

  return (
    <span
      data-arbiter-permission=""
      data-arbiter-surface="permission-selector"
      className="arb:relative arb:inline-flex arb:items-center arb:gap-1.5"
    >
      <button
        ref={trigger}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-busy={admission.state.pending}
        aria-label={
          admission.state.pending
            ? t('permission.busy')
            : t('permission.trigger.open', { current: label })
        }
        title={failure ?? label}
        disabled={!interactive && !open}
        onClick={() => {
          setOpen(!open);
        }}
        className={`arb:h-7 arb:max-w-[220px] arb:truncate arb:rounded-md arb:border-0 arb:bg-transparent arb:px-2 arb:text-[13px] arb:text-secondary ${
          interactive ? 'arb:cursor-pointer' : 'arb:cursor-default'
        }`}
      >
        {admission.state.pending ? t('permission.busy') : label}
      </button>
      {open ? (
        <Menu
          id={menuId}
          items={items}
          onChoose={(id, danger) => {
            choose(id, danger).catch(() => undefined);
          }}
          onClose={close}
        />
      ) : null}
      {confirming === null ? null : (
        <Confirmation
          acknowledged={acknowledged}
          onAcknowledged={setAcknowledged}
          onCancel={() => {
            setConfirming(null);
            setAcknowledged(false);
            trigger.current?.focus();
          }}
          onConfirm={() => {
            const preset = confirming;
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

function Menu(props: {
  readonly id: string;
  readonly items: ReturnType<typeof selectorItems>;
  readonly onChoose: (id: string, danger: boolean) => void;
  readonly onClose: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  return (
    <span
      id={props.id}
      role="menu"
      aria-label={t('permission.label')}
      className="arb:absolute arb:bottom-[34px] arb:z-20 arb:flex arb:min-w-[240px] arb:flex-col arb:rounded-lg arb:border arb:border-border-default arb:bg-layer-3 arb:p-1 arb:shadow-lg"
    >
      {props.items.map((item) => (
        <button
          key={item.id}
          type="button"
          role="menuitemradio"
          aria-checked={item.current}
          aria-label={item.label}
          title={item.hint}
          onClick={() => {
            props.onChoose(item.id, item.danger);
          }}
          className={`arb:flex arb:cursor-pointer arb:flex-col arb:items-start arb:gap-0.5 arb:rounded-md arb:border-0 arb:bg-transparent arb:px-2 arb:py-1.5 arb:text-left arb:text-[12.5px] hover:arb:bg-layer-4 ${
            item.danger ? 'arb:text-error' : 'arb:text-primary'
          }`}
        >
          <span className="arb:font-medium">{item.label}</span>
          <span className="arb:text-[11.5px] arb:text-tertiary">
            {item.hint}
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={props.onClose}
        className="arb:mt-0.5 arb:cursor-pointer arb:border-0 arb:bg-transparent arb:px-2 arb:py-1 arb:text-left arb:text-[11.5px] arb:text-tertiary hover:arb:text-primary"
      >
        {t('permission.confirm.cancel')}
      </button>
    </span>
  );
}

function Confirmation(props: {
  readonly acknowledged: boolean;
  readonly onAcknowledged: (value: boolean) => void;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const acknowledgeId = useId();
  return (
    <span
      role="dialog"
      aria-modal="false"
      aria-labelledby={`${acknowledgeId}-title`}
      className="arb:absolute arb:bottom-[34px] arb:z-30 arb:flex arb:w-[300px] arb:flex-col arb:gap-2 arb:rounded-lg arb:border arb:border-border-default arb:bg-layer-3 arb:p-3 arb:text-primary arb:shadow-lg"
    >
      <strong
        id={`${acknowledgeId}-title`}
        className="arb:text-[13px] arb:font-semibold"
      >
        {t('permission.confirm.title')}
      </strong>
      <span className="arb:text-xs arb:text-secondary">
        {t('permission.confirm.description')}
      </span>
      <label className="arb:flex arb:items-start arb:gap-1.5 arb:text-xs">
        <input
          type="checkbox"
          checked={props.acknowledged}
          onChange={(event) => {
            props.onAcknowledged(event.target.checked);
          }}
        />
        <span>{t('permission.confirm.acknowledge')}</span>
      </label>
      <span className="arb:flex arb:justify-end arb:gap-2">
        <button
          type="button"
          onClick={props.onCancel}
          className="arb:cursor-pointer arb:rounded arb:border arb:border-border-subtle arb:bg-layer-2 arb:px-2 arb:py-1 arb:text-xs arb:text-secondary hover:arb:text-primary"
        >
          {t('permission.confirm.cancel')}
        </button>
        <button
          type="button"
          disabled={!props.acknowledged}
          onClick={props.onConfirm}
          className="arb:cursor-pointer arb:rounded arb:border-0 arb:bg-accent arb:px-2 arb:py-1 arb:text-xs arb:text-accent-foreground disabled:arb:cursor-not-allowed disabled:arb:opacity-50"
        >
          {t('permission.confirm.enable')}
        </button>
      </span>
    </span>
  );
}
