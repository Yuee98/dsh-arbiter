import type { ReactNode } from 'react';

import {
  Field,
  NumberInput,
  Section,
  Select,
  TextInput,
  inputStyle,
} from '../components/controls.js';
import { useArbiterTranslation } from '../i18n-provider.js';

import type { Draft } from '../view-types.js';

export function AdvancedPanel(props: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const { draft, onDraft } = props;

  return (
    <>
      <PolicySettings draft={draft} onDraft={onDraft} />

      <ContextSettings draft={draft} onDraft={onDraft} />

      <AuditSettings draft={draft} onDraft={onDraft} />
    </>
  );
}

function PolicySettings({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const thresholdFields = [
    ['tauAuth', t('advanced.tauAuth'), 0, 1, 0.05],
    ['tauRisk', t('advanced.tauRisk'), 0, 1, 0.05],
    ['tauCritical', t('advanced.tauCritical'), 0, 1, 0.05],
    ['tauLow', t('advanced.tauLow'), 0, 1, 0.05],
    ['chatLowRiskMax', t('advanced.chatLowMax'), 0, 10, 1],
    ['chatMediumRiskMax', t('advanced.chatMediumMax'), 0, 10, 1],
    ['mediumRiskCeiling', t('advanced.decisionMax'), 0, 10, 1],
    ['explicitFromRisk', t('advanced.explicitRisk'), 0, 10, 1],
  ] as const;
  return (
    <Section
      title={t('advanced.policyTitle')}
      description={t('advanced.policyDescription')}
    >
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 10,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
          {t('advanced.parameter')}
        </div>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
          {t('advanced.normal')}
        </div>
        <div style={{ fontWeight: 600, fontSize: 12.5 }}>
          {t('advanced.progress')}
        </div>
        {thresholdFields.map(([key, label, min, max, step]) => (
          <div key={key} style={{ display: 'contents' }}>
            <div style={{ fontSize: 12.5, lineHeight: '30px' }}>{label}</div>
            <NumberInput
              value={draft.policy.normal[key]}
              min={min}
              max={max}
              step={step}
              onChange={(value) => {
                onDraft((next) => {
                  next.policy.normal[key] = value;
                });
              }}
            />
            <NumberInput
              value={draft.policy.progress[key]}
              min={min}
              max={max}
              step={step}
              onChange={(value) => {
                onDraft((next) => {
                  next.policy.progress[key] = value;
                });
              }}
            />
          </div>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 16 }}>
        <label
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12.5,
          }}
        >
          <input
            type="checkbox"
            checked={draft.policy.progress.allowBulkEgress}
            onChange={(event) => {
              onDraft((next) => {
                next.policy.progress.allowBulkEgress = event.target.checked;
              });
            }}
          />
          {t('advanced.bulkEgress')}
        </label>
        <Field label={t('advanced.probeMode')}>
          <Select
            value={draft.policy.probeMode}
            options={['assist', 'override'] as const}
            labels={{
              assist: t('advanced.assist'),
              override: t('advanced.override'),
            }}
            onChange={(value) => {
              onDraft((next) => {
                next.policy.probeMode = value;
              });
            }}
          />
        </Field>
      </div>
    </Section>
  );
}

function ContextSettings({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <Section title={t('advanced.contextTitle')}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
        }}
      >
        <Field label={t('advanced.maxInput')}>
          <NumberInput
            value={draft.context.maxInputTokens}
            min={1000}
            max={200000}
            onChange={(value) => {
              onDraft((next) => {
                next.context.maxInputTokens = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.evidenceMax')}>
          <NumberInput
            value={draft.context.evidenceMaxItems}
            min={1}
            max={200}
            onChange={(value) => {
              onDraft((next) => {
                next.context.evidenceMaxItems = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.parentHuman')}>
          <NumberInput
            value={draft.context.parentHumanItems}
            min={0}
            max={100}
            onChange={(value) => {
              onDraft((next) => {
                next.context.parentHumanItems = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.parentFloor')}>
          <NumberInput
            value={draft.context.parentEvidenceFloor}
            min={0}
            max={100}
            onChange={(value) => {
              onDraft((next) => {
                next.context.parentEvidenceFloor = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.historyMax')}>
          <NumberInput
            value={draft.context.historyMaxItems}
            min={1}
            max={400}
            onChange={(value) => {
              onDraft((next) => {
                next.context.historyMaxItems = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.checkpointMax')}>
          <NumberInput
            value={draft.context.checkpointMaxItems}
            min={0}
            max={20}
            onChange={(value) => {
              onDraft((next) => {
                next.context.checkpointMaxItems = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.argumentMax')}>
          <NumberInput
            value={draft.context.toolCallArgumentMaxChars}
            min={20}
            max={10000}
            onChange={(value) => {
              onDraft((next) => {
                next.context.toolCallArgumentMaxChars = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.projectFiles')}>
          <TextInput
            value={draft.context.projectRules.files.join(', ')}
            onChange={(value) => {
              onDraft((next) => {
                next.context.projectRules.files = value
                  .split(',')
                  .map((item) => item.trim())
                  .filter((item) => item.length > 0);
              });
            }}
            monospace
          />
        </Field>
        <Field label={t('advanced.projectEnabled')}>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              height: 30,
              fontSize: 12.5,
            }}
          >
            <input
              type="checkbox"
              checked={draft.context.projectRules.enabled}
              onChange={(event) => {
                onDraft((next) => {
                  next.context.projectRules.enabled = event.target.checked;
                });
              }}
            />
            {t('advanced.enabled')}
          </label>
        </Field>
      </div>
      <Field label={t('advanced.customRules')}>
        <textarea
          value={draft.context.customRules}
          rows={5}
          onChange={(event) => {
            onDraft((next) => {
              next.context.customRules = event.target.value;
            });
          }}
          style={{ ...inputStyle, height: 'auto', padding: 8 }}
        />
      </Field>
    </Section>
  );
}

function AuditSettings({
  draft,
  onDraft,
}: {
  readonly draft: Draft;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();

  return (
    <Section title={t('advanced.auditTitle')}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 12,
        }}
      >
        <Field label={t('advanced.retentionDays')}>
          <NumberInput
            value={draft.audit.retentionDays}
            min={1}
            max={3650}
            onChange={(value) => {
              onDraft((next) => {
                next.audit.retentionDays = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.retentionBytes')}>
          <NumberInput
            value={draft.audit.retentionBytes}
            min={1024 * 1024}
            max={1024 * 1024 * 1024 * 1024}
            onChange={(value) => {
              onDraft((next) => {
                next.audit.retentionBytes = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.queue')}>
          <NumberInput
            value={draft.audit.maxQueue}
            min={1}
            max={100000}
            onChange={(value) => {
              onDraft((next) => {
                next.audit.maxQueue = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.breakerMode')}>
          <Select
            value={draft.breaker.mode}
            options={['off', 'preset', 'custom'] as const}
            onChange={(value) => {
              onDraft((next) => {
                next.breaker.mode = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.preset')}>
          <Select
            value={draft.breaker.preset}
            options={['strict', 'balanced', 'lenient'] as const}
            onChange={(value) => {
              onDraft((next) => {
                next.breaker.preset = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.budget')}>
          <TextInput
            value={
              draft.reviewBudget === null ? '' : String(draft.reviewBudget)
            }
            placeholder={t('advanced.null')}
            onChange={(value) => {
              onDraft((next) => {
                next.reviewBudget =
                  value.trim().length === 0 ? null : Number(value);
              });
            }}
          />
        </Field>
      </div>
      {draft.breaker.mode === 'custom' ? (
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: '1fr 1fr 1fr',
            gap: 12,
          }}
        >
          <Field label={t('advanced.consecutiveDenials')}>
            <NumberInput
              value={draft.breaker.consecutiveDenials}
              min={0}
              max={100}
              onChange={(value) => {
                onDraft((next) => {
                  next.breaker.consecutiveDenials = value;
                });
              }}
            />
          </Field>
          <Field label={t('advanced.windowDenials')}>
            <NumberInput
              value={draft.breaker.windowDenials}
              min={0}
              max={100}
              onChange={(value) => {
                onDraft((next) => {
                  next.breaker.windowDenials = value;
                });
              }}
            />
          </Field>
          <Field label={t('advanced.windowSize')}>
            <NumberInput
              value={draft.breaker.windowSize}
              min={1}
              max={100}
              onChange={(value) => {
                onDraft((next) => {
                  next.breaker.windowSize = value;
                });
              }}
            />
          </Field>
        </div>
      ) : null}
      <p
        style={{
          margin: 0,
          color: 'var(--dsw-alias-label-tertiary)',
          fontSize: 11.5,
        }}
      >
        {t('advanced.auditDescription')}
      </p>
    </Section>
  );
}
