import type { CSSProperties, ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import type { Translate } from '../i18n.js';

/** The observable result of the last save attempt in this page session. */
export type SaveStatus = 'idle' | 'saved' | 'unchanged' | 'failed';

interface ConfigActionsProps {
  readonly fileRevision: string | null;
  readonly effectiveRevision: string;
  readonly snapshotId: string;
  readonly format: string;
  readonly formatExplicit: boolean;
  readonly documentPath: string | null;
  readonly dirty: boolean;
  readonly busy: boolean;
  readonly canSave: boolean;
  readonly status: SaveStatus;
  readonly auditNotice: string | null;
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

function statusText(status: SaveStatus, dirty: boolean, t: Translate): string {
  if (status === 'failed') return t('config.status.failed');
  if (dirty) return t('config.status.dirty');
  if (status === 'saved') return t('config.status.saved');
  if (status === 'unchanged') return t('config.status.unchanged');
  return t('config.status.synced');
}

/**
 * Configuration identity and the save bar.
 *
 * The identities are shown separately because they answer different questions:
 * the file revision detects concurrent edits, the effective revision and its
 * content snapshot identify what actually runs, and the format declares which
 * rule semantics this document uses.
 */
export function ConfigActions(props: ConfigActionsProps): ReactNode {
  const t = useArbiterTranslation();
  const inactiveStyle: CSSProperties = {
    cursor: props.busy ? 'default' : 'pointer',
    opacity: props.busy ? 0.5 : 1,
  };
  const saveDisabled = props.busy || !props.canSave;
  const metaStyle: CSSProperties = {
    fontSize: 12,
    color: 'var(--dsw-alias-label-tertiary)',
  };
  return (
    <div
      data-arbiter-config-actions=""
      style={{ display: 'flex', flexDirection: 'column', gap: 8 }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 12,
        }}
      >
        <div>
          <div style={{ fontSize: 15, fontWeight: 600 }}>{t('title')}</div>
          <div style={metaStyle}>
            <span data-arbiter-file-revision="">
              {props.fileRevision === null
                ? t('config.fileRevisionUnavailable')
                : t('config.fileRevision', {
                    revision: props.fileRevision,
                  })}
            </span>
            {' · '}
            <span data-arbiter-effective-revision="">
              {t('config.effectiveRevision', {
                revision: props.effectiveRevision,
              })}
            </span>
            {' · '}
            <span data-arbiter-snapshot="">
              {t('config.snapshot', { snapshot: props.snapshotId })}
            </span>
          </div>
          <div style={metaStyle}>
            <span data-arbiter-config-format={props.format}>
              {t('config.format', { format: props.format })}
              {props.formatExplicit ? null : t('config.formatImplicit')}
            </span>
            {props.documentPath === null ? null : ` · ${props.documentPath}`}
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
      <div
        data-testid="arbiter-save-status"
        data-arbiter-save-status={props.status}
        style={{ fontSize: 12.5 }}
      >
        {statusText(props.status, props.dirty, t)}
        {/*
          The page already localized this notice; translating it again would
          repeat the explanatory sentence around a finished sentence.
        */}
        {props.auditNotice === null ? null : ` · ${props.auditNotice}`}
      </div>
    </div>
  );
}
