import { useState } from 'react';
import type { ReactNode } from 'react';

import {
  Field,
  NumberInput,
  RadioGroup,
  Section,
  Select,
  TextInput,
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
    ['chatMediumRiskMax', t('advanced.chatMediumMax'), 0, 10, 1],
    ['mediumRiskCeiling', t('advanced.decisionMax'), 0, 10, 1],
    ['explicitFromRisk', t('advanced.explicitRisk'), 0, 10, 1],
  ] as const;
  return (
    <Section
      title={t('advanced.policyTitle')}
      description={t('advanced.policyDescription')}
    >
      <div className="arb:grid arb:grid-cols-3 arb:gap-2.5 arb:max-w-xl">
        <div className="arb:text-xs arb:font-semibold arb:text-primary">
          {t('advanced.parameter')}
        </div>
        <div className="arb:text-xs arb:font-semibold arb:text-primary">
          {t('advanced.normal')}
        </div>
        <div className="arb:text-xs arb:font-semibold arb:text-primary">
          {t('advanced.progress')}
        </div>
        {thresholdFields.map(([key, label, min, max, step]) => (
          <div key={key} className="arb:contents">
            <div className="arb:text-xs arb:leading-[30px] arb:text-secondary">
              {label}
            </div>
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
      <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-4 arb:pt-2">
        <label className="arb:flex arb:cursor-pointer arb:items-center arb:gap-1.5 arb:text-xs arb:text-primary">
          <input
            type="checkbox"
            checked={draft.policy.progress.allowBulkEgress}
            className="arb:rounded arb:border-border-default arb:accent-accent"
            onChange={(event) => {
              onDraft((next) => {
                next.policy.progress.allowBulkEgress = event.target.checked;
              });
            }}
          />
          {t('advanced.bulkEgress')}
        </label>
        <div className="arb:flex arb:flex-col arb:gap-1.5 arb:text-xs">
          <span className="arb:text-secondary">{t('advanced.probeMode')}</span>
          <RadioGroup
            name="advanced-probe-mode"
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
        </div>
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
  const [filesText, setFilesText] = useState<string | null>(null);

  return (
    <Section title={t('advanced.contextTitle')}>
      <div className="arb:grid arb:grid-cols-1 arb:gap-3.5 sm:arb:grid-cols-2 lg:arb:grid-cols-3 arb:max-w-3xl">
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
        <div className="sm:arb:col-span-2">
          <Field label={t('advanced.projectFiles')}>
            <TextInput
              value={filesText ?? draft.context.projectRules.files.join(', ')}
              onChange={(value) => {
                setFilesText(value);
                onDraft((next) => {
                  next.context.projectRules.files = value
                    .split(',')
                    .map((item) => item.trim())
                    .filter((item) => item.length > 0);
                });
              }}
              onBlur={() => {
                setFilesText(null);
              }}
              monospace
            />
          </Field>
        </div>
        <Field label={t('advanced.projectEnabled')}>
          <label className="arb:flex arb:h-[30px] arb:cursor-pointer arb:items-center arb:gap-1.5 arb:text-xs arb:text-primary">
            <input
              type="checkbox"
              checked={draft.context.projectRules.enabled}
              className="arb:rounded arb:border-border-default arb:accent-accent"
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
      <div className="arb:max-w-3xl">
        <Field label={t('advanced.customRules')}>
          <textarea
            value={draft.context.customRules}
            rows={5}
            onChange={(event) => {
              onDraft((next) => {
                next.context.customRules = event.target.value;
              });
            }}
            className="arb:h-auto arb:w-full arb:rounded-md arb:border arb:border-border-default arb:bg-layer-3 arb:p-2 arb:text-xs arb:text-primary arb:focus:border-accent arb:focus:outline-none"
          />
        </Field>
      </div>
    </Section>
  );
}

function BudgetInput({
  value,
  placeholder,
  onChange,
}: {
  readonly value: number | null;
  readonly placeholder?: string;
  readonly onChange: (value: number | null) => void;
}): ReactNode {
  const [budgetText, setBudgetText] = useState<string | null>(null);

  return (
    <TextInput
      value={budgetText ?? (value === null ? '' : String(value))}
      placeholder={placeholder}
      onChange={(text) => {
        setBudgetText(text);
        if (text.trim().length === 0) {
          onChange(null);
          return;
        }
        const parsed = Number(text);
        if (Number.isFinite(parsed)) {
          onChange(parsed);
        }
      }}
      onBlur={() => {
        setBudgetText(null);
      }}
    />
  );
}

function RetentionBytesInput({
  value,
  onChange,
}: {
  readonly value: number;
  readonly onChange: (value: number) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const formatBytes = (bytes: number): string => {
    if (bytes >= 1024 * 1024 * 1024) {
      return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
    }
    return `${String(Math.round(bytes / (1024 * 1024)))} MB`;
  };
  const presets = [
    { label: t('advanced.retentionPreset50MB'), bytes: 50 * 1024 * 1024 },
    { label: t('advanced.retentionPreset100MB'), bytes: 100 * 1024 * 1024 },
    { label: t('advanced.retentionPreset500MB'), bytes: 500 * 1024 * 1024 },
    { label: t('advanced.retentionPreset1GB'), bytes: 1024 * 1024 * 1024 },
  ];

  return (
    <div className="arb:flex arb:flex-col arb:gap-1.5">
      <NumberInput
        value={value}
        min={1024 * 1024}
        max={1024 * 1024 * 1024 * 1024}
        onChange={onChange}
      />
      <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-1.5 arb:text-[11.5px] arb:text-secondary">
        <span>
          {t('advanced.retentionFormatted', { formatted: formatBytes(value) })}
        </span>
        <div className="arb:flex arb:gap-1">
          {presets.map((p) => (
            <button
              key={p.bytes}
              type="button"
              onClick={() => {
                onChange(p.bytes);
              }}
              className="arb:rounded arb:border arb:border-border-default arb:bg-layer-3 arb:px-1.5 arb:py-0.5 arb:text-[11px] arb:text-primary arb:hover:bg-layer-4"
            >
              {p.label}
            </button>
          ))}
        </div>
      </div>
    </div>
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
      <div className="arb:grid arb:grid-cols-1 arb:gap-3.5 sm:arb:grid-cols-2 lg:arb:grid-cols-3 arb:max-w-3xl">
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
          <RetentionBytesInput
            value={draft.audit.retentionBytes}
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
            disabled={draft.breaker.mode !== 'preset'}
            onChange={(value) => {
              onDraft((next) => {
                next.breaker.preset = value;
              });
            }}
          />
        </Field>
        <Field label={t('advanced.budget')}>
          <BudgetInput
            value={draft.reviewBudget}
            placeholder={t('advanced.null')}
            onChange={(value) => {
              onDraft((next) => {
                next.reviewBudget = value;
              });
            }}
          />
        </Field>
      </div>
      {draft.breaker.mode === 'custom' ? (
        <div className="arb:mt-3 arb:grid arb:grid-cols-1 arb:gap-3.5 sm:arb:grid-cols-3 arb:max-w-3xl">
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
      <p className="arb:m-0 arb:pt-2 arb:text-[11.5px] arb:text-tertiary">
        {t('advanced.auditDescription')}
      </p>
    </Section>
  );
}
