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
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}
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
        style={{
          height: 28,
          maxWidth: 220,
          padding: '0 8px',
          borderRadius: 6,
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-label-secondary)',
          cursor: interactive ? 'pointer' : 'default',
          fontSize: 13,
          whiteSpace: 'nowrap',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
        }}
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
        style={{
          fontSize: 11.5,
          color:
            failure === null
              ? 'var(--dsw-alias-label-tertiary)'
              : 'var(--dsw-alias-state-error-primary)',
          maxWidth: 260,
        }}
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
      style={{
        position: 'absolute',
        bottom: 34,
        zIndex: 20,
        display: 'flex',
        flexDirection: 'column',
        minWidth: 240,
        padding: 4,
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        boxShadow: '0 4px 16px rgb(0 0 0 / 18%)',
      }}
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
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'flex-start',
            gap: 2,
            padding: '6px 8px',
            borderRadius: 6,
            border: 'none',
            background: 'transparent',
            textAlign: 'left',
            cursor: 'pointer',
            fontSize: 12.5,
            color: item.danger
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-primary)',
          }}
        >
          <span style={{ fontWeight: 500 }}>{item.label}</span>
          <span
            style={{
              fontSize: 11.5,
              color: 'var(--dsw-alias-label-tertiary)',
              whiteSpace: 'normal',
            }}
          >
            {item.hint}
          </span>
        </button>
      ))}
      <button
        type="button"
        onClick={props.onClose}
        style={{
          marginTop: 2,
          padding: '4px 8px',
          border: 'none',
          background: 'transparent',
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 11.5,
          cursor: 'pointer',
          textAlign: 'left',
        }}
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
      style={{
        position: 'absolute',
        bottom: 34,
        zIndex: 21,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        width: 300,
        padding: 12,
        borderRadius: 8,
        border: '0.5px solid var(--dsw-alias-border-l4)',
        background: 'var(--dsw-alias-bg-layer-3)',
        color: 'var(--dsw-alias-label-primary)',
      }}
    >
      <strong id={`${acknowledgeId}-title`} style={{ fontSize: 13 }}>
        {t('permission.confirm.title')}
      </strong>
      <span
        style={{
          fontSize: 12,
          color: 'var(--dsw-alias-label-secondary)',
          whiteSpace: 'normal',
        }}
      >
        {t('permission.confirm.description')}
      </span>
      <label
        style={{
          display: 'flex',
          gap: 6,
          alignItems: 'flex-start',
          fontSize: 12,
        }}
      >
        <input
          type="checkbox"
          checked={props.acknowledged}
          onChange={(event) => {
            props.onAcknowledged(event.target.checked);
          }}
        />
        <span>{t('permission.confirm.acknowledge')}</span>
      </label>
      <span style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        <button type="button" onClick={props.onCancel}>
          {t('permission.confirm.cancel')}
        </button>
        <button
          type="button"
          disabled={!props.acknowledged}
          onClick={props.onConfirm}
        >
          {t('permission.confirm.enable')}
        </button>
      </span>
    </span>
  );
}
