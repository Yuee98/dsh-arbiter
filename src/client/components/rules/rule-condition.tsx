import type { ReactNode } from 'react';
import { useState } from 'react';
import type { RuleKind, RuleTarget } from '../../../types.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { Button, Select, TextInput, inputClassName } from '../controls.js';
import {
  convertExactPattern,
  exactType,
  isBlankPattern,
  patternText,
} from './draft.js';
import type { MutableRuleCondition, PendingExactType } from './draft.js';

const TARGETS: readonly RuleTarget[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
  'argument',
];
const KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];
const VALUE_TYPES = ['string', 'number', 'boolean', 'null'] as const;

type ValueType = (typeof VALUE_TYPES)[number];

export function RuleConditionEditor(props: {
  readonly index: number;
  readonly condition: MutableRuleCondition;
  readonly pendingType?: PendingExactType | null;
  readonly onPendingTypeChange?: (type: PendingExactType | null) => void;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition, onChange, onPendingTypeChange } = props;
  const isArgument = condition.target === 'argument';
  const isExact = condition.kind === 'exact';

  const [localPendingType, setLocalPendingType] =
    useState<PendingExactType | null>(null);

  const effectivePendingType =
    props.pendingType !== undefined ? props.pendingType : localPendingType;

  const setEffectivePendingType = (next: PendingExactType | null): void => {
    onPendingTypeChange?.(next);
    setLocalPendingType(next);
  };

  const isBlank = isBlankPattern(condition.pattern);

  const currentExactType: ValueType = isExact
    ? (effectivePendingType ?? exactType(condition.pattern))
    : 'string';

  return (
    <div
      role="group"
      aria-label={t('rules.conditionIndex', { index: props.index + 1 })}
      className="arb:flex arb:flex-col arb:gap-2 arb:rounded-md arb:border arb:border-border-subtle arb:p-2.5"
    >
      <div className="arb:flex arb:flex-wrap arb:gap-2.5">
        <div className="arb:flex arb:w-36 arb:flex-col arb:gap-1">
          <span className="arb:text-[11.5px] arb:text-secondary">
            {t('rules.target')}
          </span>
          <Select
            ariaLabel={t('rules.target')}
            value={condition.target}
            options={TARGETS}
            labels={{
              command: t('rules.targetOption.command'),
              file_redirect: t('rules.targetOption.fileRedirect'),
              variable_assignment: t('rules.targetOption.variableAssignment'),
              tool: t('rules.targetOption.tool'),
              argument: t('rules.targetOption.argument'),
            }}
            onChange={(value) => {
              onChange((next) => {
                next.target = value;
                if (patternText(next.pattern).length === 0) {
                  next.kind = value === 'argument' ? 'exact' : 'regex';
                }
                if (value !== 'argument' && typeof next.pattern !== 'string') {
                  next.pattern = patternText(next.pattern);
                }
                if (value === 'argument') return;
                delete next.path;
                delete next.multi;
              });
            }}
          />
        </div>
        <div className="arb:flex arb:w-32 arb:flex-col arb:gap-1">
          <span className="arb:text-[11.5px] arb:text-secondary">
            {t('rules.kind')}
          </span>
          <Select
            ariaLabel={t('rules.kind')}
            value={condition.kind}
            options={KINDS}
            labels={{
              exact: t('rules.kindOption.exact'),
              regex: t('rules.kindOption.regex'),
              glob: t('rules.kindOption.glob'),
            }}
            onChange={(value) => {
              if (value !== 'exact') {
                setEffectivePendingType(null);
              }
              onChange((next) => {
                next.kind = value;
                if (value !== 'exact' && typeof next.pattern !== 'string') {
                  next.pattern = patternText(next.pattern);
                }
              });
            }}
          />
        </div>
        {isArgument ? (
          <div className="arb:flex arb:min-w-[200px] arb:flex-1 arb:flex-col arb:gap-1">
            <span className="arb:text-[11.5px] arb:text-secondary">
              {t('rules.jsonPath')}
            </span>
            <TextInput
              ariaLabel={t('rules.jsonPath')}
              value={condition.path ?? ''}
              placeholder={t('rules.jsonPathPlaceholder')}
              monospace
              onChange={(value) => {
                onChange((next) => {
                  if (value.length === 0) delete next.path;
                  else next.path = value;
                });
              }}
            />
          </div>
        ) : null}
        {isArgument ? (
          <div className="arb:flex arb:w-28 arb:flex-col arb:gap-1">
            <span className="arb:text-[11.5px] arb:text-secondary">
              {t('rules.multi')}
            </span>
            <Select
              ariaLabel={t('rules.multi')}
              value={condition.multi ?? 'any'}
              options={['any', 'all'] as const}
              labels={{
                any: t('rules.multiOption.any'),
                all: t('rules.multiOption.all'),
              }}
              onChange={(value) => {
                onChange((next) => {
                  next.multi = value;
                });
              }}
            />
          </div>
        ) : null}
      </div>

      <div className="arb:flex arb:flex-wrap arb:gap-2.5">
        {isExact ? (
          <ExactTypeSelector
            currentExactType={currentExactType}
            isBlank={isBlank}
            condition={condition}
            onSetEffectivePendingType={setEffectivePendingType}
            onChange={onChange}
          />
        ) : null}
        <div className="arb:flex arb:min-w-[240px] arb:flex-1 arb:flex-col arb:gap-1">
          <span className="arb:text-[11.5px] arb:text-secondary">
            {t('rules.pattern')}
          </span>
          <ExactValue
            type={currentExactType}
            pendingType={effectivePendingType}
            condition={condition}
            onCommitType={() => {
              setEffectivePendingType(null);
            }}
            onChange={onChange}
          />
        </div>
      </div>

      <div className="arb:flex arb:items-center arb:gap-3">
        <label className="arb:flex arb:items-center arb:gap-1.5 arb:text-xs">
          <input
            type="checkbox"
            checked={condition.caseSensitive === false}
            onChange={(event) => {
              onChange((next) => {
                if (event.target.checked) next.caseSensitive = false;
                else delete next.caseSensitive;
              });
            }}
            className="arb:rounded arb:border-border-default arb:accent-accent"
          />
          {t('rules.caseInsensitive')}
        </label>
        <Button onClick={props.onRemove} tone="plain">
          {t('rules.removeCondition')}
        </Button>
      </div>
    </div>
  );
}

function ExactTypeSelector(props: {
  readonly currentExactType: ValueType;
  readonly isBlank: boolean;
  readonly condition: MutableRuleCondition;
  readonly onSetEffectivePendingType: (type: PendingExactType | null) => void;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const {
    currentExactType,
    isBlank,
    condition,
    onSetEffectivePendingType,
    onChange,
  } = props;

  return (
    <div className="arb:flex arb:w-28 arb:flex-col arb:gap-1">
      <span className="arb:text-[11.5px] arb:text-secondary">
        {t('rules.valueType')}
      </span>
      <Select
        ariaLabel={t('rules.valueType')}
        value={currentExactType}
        options={VALUE_TYPES}
        labels={{
          string: t('rules.valueTypeOption.string'),
          number: t('rules.valueTypeOption.number'),
          boolean: t('rules.valueTypeOption.boolean'),
          null: t('rules.valueTypeOption.null'),
        }}
        onChange={(value) => {
          if (value === 'null') {
            onSetEffectivePendingType(null);
            onChange((next) => {
              next.pattern = null;
            });
            return;
          }
          if (value === 'string') {
            onSetEffectivePendingType(null);
            onChange((next) => {
              next.pattern =
                condition.pattern === null
                  ? ''
                  : patternText(condition.pattern);
            });
            return;
          }
          if (value === 'boolean') {
            if (
              typeof condition.pattern === 'boolean' ||
              condition.pattern === 'true' ||
              condition.pattern === 'false'
            ) {
              onSetEffectivePendingType(null);
              onChange((next) => {
                next.pattern =
                  condition.pattern === true || condition.pattern === 'true';
              });
            } else {
              onSetEffectivePendingType('boolean');
            }
            return;
          }
          // value === 'number'
          if (
            typeof condition.pattern === 'number' ||
            (!isBlank &&
              Number.isFinite(Number(patternText(condition.pattern))))
          ) {
            onSetEffectivePendingType(null);
            onChange((next) => {
              next.pattern = convertExactPattern(next.pattern, 'number');
            });
          } else {
            onSetEffectivePendingType('number');
          }
        }}
      />
    </div>
  );
}

function ExactValue(props: {
  readonly type: ValueType;
  readonly pendingType: PendingExactType | null;
  readonly condition: MutableRuleCondition;
  readonly onCommitType: () => void;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition, onChange, onCommitType } = props;

  if (props.type === 'null') {
    return (
      <div className="arb:flex arb:h-[30px] arb:items-center arb:text-xs arb:text-secondary">
        {t('rules.valueTypeOption.null')}
      </div>
    );
  }

  if (props.type === 'boolean') {
    if (typeof condition.pattern === 'boolean') {
      return (
        <Select
          ariaLabel={t('rules.pattern')}
          value={condition.pattern ? 'true' : 'false'}
          options={['true', 'false'] as const}
          labels={{
            true: t('rules.booleanTrue'),
            false: t('rules.booleanFalse'),
          }}
          onChange={(value) => {
            onCommitType();
            onChange((next) => {
              next.pattern = value === 'true';
            });
          }}
        />
      );
    }

    return (
      <Select
        ariaLabel={t('rules.pattern')}
        value=""
        options={['', 'true', 'false'] as const}
        labels={{
          '': t('rules.selectBooleanValue'),
          true: t('rules.booleanTrue'),
          false: t('rules.booleanFalse'),
        }}
        onChange={(value) => {
          if (value === 'true' || value === 'false') {
            onCommitType();
            onChange((next) => {
              next.pattern = value === 'true';
            });
          }
        }}
      />
    );
  }

  if (props.type === 'number') {
    return (
      <NumberPattern
        value={
          typeof condition.pattern === 'number' ? condition.pattern : undefined
        }
        onChange={(value) => {
          onCommitType();
          onChange((next) => {
            next.pattern = value;
          });
        }}
      />
    );
  }

  return (
    <TextInput
      ariaLabel={t('rules.pattern')}
      value={patternText(condition.pattern)}
      placeholder={t('rules.patternPlaceholder')}
      monospace
      onChange={(value) => {
        onChange((next) => {
          next.pattern = value;
        });
      }}
    />
  );
}

function NumberPattern(props: {
  readonly value: number | undefined;
  readonly onChange: (value: number) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const [draft, setDraft] = useState<string | null>(null);

  return (
    <input
      type="text"
      inputMode="decimal"
      aria-label={t('rules.pattern')}
      value={
        draft ?? (props.value !== undefined ? patternText(props.value) : '')
      }
      onChange={(event) => {
        const text = event.target.value;
        setDraft(text);
        const parsed = Number(text);
        if (text.trim().length === 0 || !Number.isFinite(parsed)) return;
        props.onChange(parsed);
      }}
      onBlur={() => {
        setDraft(null);
      }}
      className={inputClassName}
    />
  );
}
