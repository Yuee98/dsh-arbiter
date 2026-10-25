import type { CSSProperties, ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';

interface ConfigActionsProps {
  readonly revision: string;
  readonly documentPath: string | null;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly canSave: boolean;
  readonly onValidate: () => void;
  readonly onReload: () => void;
  readonly onSave: () => void;
}

const buttonStyle: CSSProperties = {
  height: 30,
  padding: '0 12px',
  borderRadius: 6,
  fontSize: 12.5,
  border: '0.5px solid var(--dsw-alias-border-l4)',
  background: 'var(--dsw-alias-bg-layer-3)',
  color: 'var(--dsw-alias-label-primary)',
};

/** Existing configuration actions, extracted as the first localized UI boundary. */
export function ConfigActions(props: ConfigActionsProps): ReactNode {
  const t = useArbiterTranslation();
  const inactiveStyle: CSSProperties = {
    cursor: props.busy ? 'default' : 'pointer',
    opacity: props.busy ? 0.5 : 1,
  };
  const saveDisabled = props.busy || !props.canSave;
  return (
    <div
      data-arbiter-config-actions=""
      style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div>
        <div style={{ fontSize: 15, fontWeight: 600 }}>{t('title')}</div>
        <div style={{ fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }}>
          {t('config.revision', { revision: props.revision })}
          {props.documentPath === null ? '' : ` · ${props.documentPath}`}
          {props.dirty ? t('config.unsavedDraft') : ''}
        </div>
      </div>
      <div
        role="group"
        aria-label={t('config.actions.label')}
        style={{ display: 'flex', gap: 8 }}
      >
        <button
          type="button"
          onClick={props.onValidate}
          disabled={props.busy}
          style={{ ...buttonStyle, ...inactiveStyle }}
        >
          {t('config.validate')}
        </button>
        <button
          type="button"
          onClick={props.onReload}
          disabled={props.busy}
          style={{ ...buttonStyle, ...inactiveStyle }}
        >
          {t('config.reload')}
        </button>
        <button
          type="button"
          onClick={props.onSave}
          disabled={saveDisabled}
          style={{
            ...buttonStyle,
            cursor: saveDisabled ? 'default' : 'pointer',
            opacity: saveDisabled ? 0.5 : 1,
            border: '0.5px solid var(--dsw-alias-state-business-primary)',
            background: 'var(--dsw-alias-state-business-primary)',
            color: 'var(--dsw-alias-label-primary-foreground, white)',
          }}
        >
          {props.busy ? t('config.busy') : t('config.save')}
        </button>
      </div>
    </div>
  );
}
