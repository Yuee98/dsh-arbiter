import type { Translate } from '../i18n.js';

import type { ReactNode } from 'react';

import { CoexistenceSection } from '../components/coexistence.js';
import {
  Field,
  Notice,
  RadioGroup,
  Section,
  Select,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { formatTime } from '../view-helpers.js';
import { issuesText } from '../view-issues.js';
import type { Draft, StateResponse } from '../view-types.js';

function modeHelp(t: Translate): Record<string, string> {
  return {
    ask: t('status.askHelp'),
    'no-ask': t('status.noAskHelp'),
  };
}

function boundaryHelp(t: Translate): Record<string, string> {
  return {
    guarded: t('status.boundaryGuardedHelp'),
    trusted: t('status.boundaryTrustedHelp'),
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
        <label className="arb:flex arb:cursor-pointer arb:items-start arb:gap-2.5 arb:text-xs arb:text-primary">
          <input
            type="checkbox"
            aria-label={t('status.enabled')}
            checked={draft.enabled}
            className="arb:mt-0.5 arb:h-4 arb:w-4 arb:cursor-pointer arb:rounded arb:border-border-default arb:accent-accent"
            onChange={(event) => {
              onDraft((next) => {
                next.enabled = event.target.checked;
              });
            }}
          />
          <div className="arb:flex arb:flex-col arb:gap-0.5">
            <span className="arb:font-medium arb:text-primary">
              {t('status.enabled')}
            </span>
            <span className="arb:text-[11px] arb:text-tertiary">
              {t('status.enabledHelp')}
            </span>
          </div>
        </label>
        <div className="arb:flex arb:flex-col arb:gap-1.5 arb:text-xs">
          <span className="arb:text-secondary">
            {t('status.boundaryLabel')}
          </span>
          <RadioGroup
            ariaLabel={t('status.boundaryLabel')}
            name="status-boundary"
            value={draft.boundary}
            options={['guarded', 'trusted'] as const}
            labels={{
              guarded: t('status.boundaryGuarded'),
              trusted: t('status.boundaryTrusted'),
            }}
            onChange={(value) => {
              onDraft((next) => {
                next.boundary = value;
              });
            }}
          />
          <span className="arb:text-[11px] arb:text-tertiary">
            {boundaryHelp(t)[draft.boundary] ?? '—'}
          </span>
        </div>
        <div className="arb:grid arb:grid-cols-[repeat(auto-fit,minmax(220px,1fr))] arb:gap-4 arb:max-w-xl">
          <Field
            label={t('status.mainMode')}
            hint={modeHelp(t)[draft.modes.main] ?? '—'}
          >
            <div className="arb:w-full">
              <Select
                value={draft.modes.main}
                options={['ask', 'no-ask'] as const}
                labels={{
                  ask: t('status.ask'),
                  'no-ask': t('status.noAsk'),
                }}
                onChange={(value) => {
                  onDraft((next) => {
                    next.modes.main = value;
                  });
                }}
              />
            </div>
          </Field>
          <Field
            label={t('status.subagentMode')}
            hint={t('status.subagentFixedHelp')}
          >
            <div className="arb:w-full">
              <Select
                value={draft.modes.subagent}
                options={['no-ask'] as const}
                labels={{ 'no-ask': t('status.noAsk') }}
                disabled
                onChange={() => {
                  // Disabled: the single accepted value is already selected.
                }}
              />
            </div>
          </Field>
        </div>
        <p className="arb:m-0 arb:text-[11.5px] arb:text-tertiary">
          {t('status.subagentNote')}
        </p>
        <p className="arb:m-0 arb:text-[11.5px] arb:text-tertiary">
          {t('status.sessionNote')}
        </p>
        <RuntimeSummary state={state} />
        {state.invalidConfigError === null ? null : (
          <Notice
            kind="error"
            text={t('status.invalidConfig', {
              // Localized issue sentences; the raw summary stays a fallback.
              error:
                state.loadErrors.length > 0
                  ? issuesText(state.loadErrors, t)
                  : state.invalidConfigError,
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
      <CoexistenceSection coexistence={state.coexistence} />
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
        <p className="arb:m-0 arb:text-xs arb:text-tertiary">
          {t('status.empty')}
        </p>
      ) : (
        <table className="arb:w-full arb:border-collapse arb:text-xs">
          <thead>
            <tr className="arb:border-b arb:border-border-default arb:text-left arb:text-secondary">
              <th className="arb:p-1.5">{t('status.time')}</th>
              <th className="arb:p-1.5">{t('status.revision')}</th>
              <th className="arb:p-1.5">{t('status.entry')}</th>
              <th className="arb:p-1.5">{t('status.snapshot')}</th>
            </tr>
          </thead>
          <tbody>
            {state.configHistory.slice(0, 5).map((activation) => (
              <tr
                key={activation.id}
                className="arb:border-b arb:border-border-subtle arb:text-primary"
              >
                <td className="arb:p-1.5">
                  {formatTime(activation.activatedAt)}
                </td>
                <td className="arb:p-1.5">
                  <code>{activation.revision}</code>
                </td>
                <td className="arb:p-1.5">
                  {activation.entry} / {activation.scope}
                </td>
                <td className="arb:p-1.5">
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
      <div className="arb:text-xs arb:leading-relaxed arb:text-primary">
        <div>
          <strong>{t('status.connected')}</strong>
        </div>
        <ul className="arb:my-1.5 arb:mb-2.5 arb:list-disc arb:pl-5 arb:text-secondary">
          {state.coverage.gated.map((item) => (
            <li key={item}>{item}</li>
          ))}
        </ul>
        <div>
          <strong>{t('status.notIndividual')}</strong>
        </div>
        <ul className="arb:m-0 arb:list-disc arb:pl-5 arb:text-secondary">
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
    <table className="arb:border-collapse arb:text-xs">
      <tbody>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.execution')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            {state.executionMode === 'trusted'
              ? t('status.trusted')
              : t('status.guarded')}
          </td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.effectiveRevision')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            <code>{state.effectiveRevision}</code>
          </td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.configSnapshot')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            <code>{state.configSnapshotId}</code>
          </td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.policyVersion')}
          </td>
          <td className="arb:py-1 arb:text-primary">{state.policyVersion}</td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.reviewer')}
          </td>
          <td className="arb:py-1 arb:text-primary">{state.reviewerType}</td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.audit')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            {state.audit.health.state}
            {state.audit.health.lastError === null
              ? ''
              : ` — ${state.audit.health.lastError}`}
          </td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.counts')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            {state.audit.stats?.calls ?? 0} /{' '}
            {state.audit.stats?.modelCalls ?? 0}
          </td>
        </tr>
        <tr>
          <td className="arb:py-1 arb:pr-3 arb:text-secondary">
            {t('status.database')}
          </td>
          <td className="arb:py-1 arb:text-primary">
            <code>{state.audit.path ?? t('status.unavailable')}</code>
          </td>
        </tr>
      </tbody>
    </table>
  );
}
