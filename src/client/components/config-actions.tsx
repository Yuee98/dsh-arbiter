import type { ReactNode } from 'react';

import { useArbiterTranslation } from '../i18n-provider.js';
import type { Translate } from '../i18n.js';
import { Button } from './controls.js';

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
  const saveDisabled = props.busy || !props.canSave;

  return (
    <div
      data-arbiter-config-actions=""
      className="arb:flex arb:flex-col arb:gap-2"
    >
      <div className="arb:flex arb:items-start arb:justify-between arb:gap-3">
        <div className="arb:min-w-0 arb:flex-1">
          <div className="arb:text-base arb:font-semibold arb:text-primary">
            {t('title')}
          </div>
          <div className="arb:text-xs arb:text-tertiary">
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
          <div className="arb:text-xs arb:text-tertiary">
            <span data-arbiter-config-format={props.format}>
              {t('config.format', { format: props.format })}
              {props.formatExplicit ? null : t('config.formatImplicit')}
            </span>
            {props.documentPath === null ? null : (
              <span
                className="arb:block arb:truncate"
                title={props.documentPath}
              >
                {` · ${props.documentPath}`}
              </span>
            )}
          </div>
        </div>

        <div
          role="group"
          aria-label={t('config.actions.label')}
          className="arb:flex arb:shrink-0 arb:flex-wrap arb:items-center arb:gap-2"
        >
          <Button
            type="button"
            onClick={props.onValidate}
            disabled={props.busy}
            className="arb:shrink-0 arb:whitespace-nowrap"
          >
            {t('config.validate')}
          </Button>
          <Button
            type="button"
            onClick={props.onReload}
            disabled={props.busy}
            className="arb:shrink-0 arb:whitespace-nowrap"
          >
            {t('config.reload')}
          </Button>
          <Button
            type="button"
            onClick={props.onSave}
            disabled={saveDisabled}
            tone="primary"
            className="arb:shrink-0 arb:whitespace-nowrap"
          >
            {props.busy ? t('config.busy') : t('config.save')}
          </Button>
        </div>
      </div>

      <div
        data-testid="arbiter-save-status"
        data-arbiter-save-status={props.status}
        className="arb:text-xs arb:text-secondary"
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
