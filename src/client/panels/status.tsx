import type { Translate } from '../i18n.js';

import type { ReactNode } from 'react';

import { Field, Notice, Section, Select } from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { formatTime } from '../view-helpers.js';
import type { Draft, StateResponse } from '../view-types.js';

function modeHelp(t: Translate): Record<string, string> {
  return {
    normal: t('status.normalHelp'),
    strict: t('status.strictHelp'),
    progress: t('status.progressHelp'),
  };
}

export function StatusPanel(props: {
  readonly state: StateResponse;
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { state, draft, onDraft } = props;
  return (
    <>
      <Section title={t('status.title')} description={t('status.description')}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            fontSize: 13,
          }}
        >
          <input
            type="checkbox"
            checked={draft.enabled}
            onChange={(event) => {
              onDraft((next) => {
                next.enabled = event.target.checked;
              });
            }}
          />
          {t('status.enabled')}
        </label>
        <div
          style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}
        >
          <Field
            label={t('status.mainMode')}
            hint={modeHelp(t)[draft.modes.main] ?? '—'}
          >
            <Select
              value={draft.modes.main}
              options={['normal', 'strict', 'progress'] as const}
              labels={{
                normal: t('status.normal'),
                strict: t('status.strict'),
                progress: t('status.progress'),
              }}
              onChange={(value) => {
                onDraft((next) => {
                  next.modes.main = value;
                });
              }}
            />
          </Field>
          <Field
            label={t('status.subagentMode')}
            hint={modeHelp(t)[draft.modes.subagent] ?? '—'}
          >
            <Select
              value={draft.modes.subagent}
              options={['strict', 'progress'] as const}
              labels={{
                strict: t('status.strict'),
                progress: t('status.progress'),
              }}
              onChange={(value) => {
                onDraft((next) => {
                  next.modes.subagent = value;
                });
              }}
            />
          </Field>
        </div>
        <RuntimeSummary state={state} />
        {state.invalidConfigError === null ? null : (
          <Notice
            kind="error"
            text={t('status.invalidConfig', {
              error: state.invalidConfigError,
            })}
          />
        )}
        {state.autoPresetError === null ? null : (
          <Notice
            kind="error"
            text={t('status.autoPresetError', { error: state.autoPresetError })}
          />
        )}
        {state.sessionRecordErrors.length === 0 ? null : (
          <Notice
            kind="info"
            text={t('status.sessionRecordError', {
              records: state.sessionRecordErrors
                .map(([id, message]) => `${id}: ${message}`)
                .join('\n'),
            })}
          />
        )}
      </Section>
      <ConfigurationHistory state={state} />
      <CoverageSummary state={state} />
    </>
  );
}

function ConfigurationHistory({
  state,
}: {
  readonly state: StateResponse;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <Section
      title={t('status.historyTitle')}
      description={t('status.historyDescription')}
    >
      {state.configHistory.length === 0 ? (
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 12.5,
          }}
        >
          {t('status.empty')}
        </p>
      ) : (
        <table style={{ borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr
              style={{
                textAlign: 'left',
                color: 'var(--dsw-alias-label-secondary)',
              }}
            >
              <th style={{ padding: 4 }}>{t('status.time')}</th>
              <th style={{ padding: 4 }}>{t('status.revision')}</th>
              <th style={{ padding: 4 }}>{t('status.entry')}</th>
              <th style={{ padding: 4 }}>{t('status.snapshot')}</th>
            </tr>
          </thead>
          <tbody>
            {state.configHistory.slice(0, 5).map((activation) => (
              <tr
                key={activation.id}
                style={{
                  borderTop: '0.5px solid var(--dsw-alias-border-l2)',
                }}
              >
                <td style={{ padding: 4 }}>
                  {formatTime(activation.activatedAt)}
                </td>
                <td style={{ padding: 4 }}>
                  <code>{activation.revision}</code>
                </td>
                <td style={{ padding: 4 }}>
                  {activation.entry} / {activation.scope}
                </td>
                <td style={{ padding: 4 }}>
                  <code>{activation.snapshotId}</code>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Section>
  );
}

function CoverageSummary({
  state,
}: {
  readonly state: StateResponse;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <Section
      title={t('status.coverageTitle')}
      description={t('status.coverageDescription')}
    >
      <div style={{ fontSize: 12.5, lineHeight: 1.7 }}>
        <div>
          <strong>{t('status.connected')}</strong>
        </div>
        <ul style={{ margin: '4px 0 10px', paddingLeft: 20 }}>
          {state.coverage.gated.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div>
          <strong>{t('status.notIndividual')}</strong>
        </div>
        <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
          {state.coverage.notGated.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
      </div>
    </Section>
  );
}

function RuntimeSummary({
  state,
}: {
  readonly state: StateResponse;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <table style={{ borderCollapse: 'collapse', fontSize: 12.5 }}>
      <tbody>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.execution')}
          </td>
          <td>
            {state.executionMode === 'trusted'
              ? t('status.trusted')
              : t('status.guarded')}
          </td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.effectiveRevision')}
          </td>
          <td>
            <code>{state.effectiveRevision}</code>
          </td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.configSnapshot')}
          </td>
          <td>
            <code>{state.configSnapshotId}</code>
          </td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.policyVersion')}
          </td>
          <td>{state.policyVersion}</td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.reviewer')}
          </td>
          <td>{state.reviewerType}</td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.audit')}
          </td>
          <td>
            {state.audit.health.state}
            {state.audit.health.lastError === null
              ? ''
              : ` — ${state.audit.health.lastError}`}
          </td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.counts')}
          </td>
          <td>
            {state.audit.stats?.calls ?? 0} /{' '}
            {state.audit.stats?.modelCalls ?? 0}
          </td>
        </tr>
        <tr>
          <td
            style={{
              padding: '3px 12px 3px 0',
              color: 'var(--dsw-alias-label-secondary)',
            }}
          >
            {t('status.database')}
          </td>
          <td>
            <code>{state.audit.path ?? t('status.unavailable')}</code>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
