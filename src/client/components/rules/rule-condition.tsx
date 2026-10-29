import { Trash2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { RuleKind, RuleTarget } from '../../../types.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { Select, TextInput, inputClassName } from '../controls.js';
import { IconButton } from '../ui/button.js';
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

/** The option label each target already renders, reused by the field note. */
const TARGET_LABEL_KEYS: Readonly<Record<RuleTarget, string>> = {
  command: 'rules.targetOption.command',
  file_redirect: 'rules.targetOption.fileRedirect',
  variable_assignment: 'rules.targetOption.variableAssignment',
  tool: 'rules.targetOption.tool',
  argument: 'rules.targetOption.argument',
};

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
  readonly isArmed?: boolean | undefined;
  readonly onArm?: (() => void) | undefined;
  readonly onDisarm?: (() => void) | undefined;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition, onChange, onPendingTypeChange } = props;
  const isArgument = condition.target === 'argument';
  const isExact = condition.kind === 'exact';
  const isTypedExact = isArgument && isExact;

  const [localPendingType, setLocalPendingType] =
    useState<PendingExactType | null>(null);

  const effectivePendingType =
    props.pendingType !== undefined ? props.pendingType : localPendingType;

  const setEffectivePendingType = (next: PendingExactType | null): void => {
    onPendingTypeChange?.(next);
    setLocalPendingType(next);
  };

  const isBlank = isBlankPattern(condition.pattern);

  const currentExactType: ValueType = isTypedExact
    ? (effectivePendingType ?? exactType(condition.pattern))
    : 'string';

  return (
    <div
      role="group"
      aria-label={t('rules.conditionIndex', { index: props.index + 1 })}
      className="arb:flex arb:flex-col arb:gap-2 arb:rounded-md arb:border arb:border-border-subtle arb:p-2.5"
    >
      <ConditionFieldNote condition={condition} />
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
              if (value !== 'argument') {
                setEffectivePendingType(null);
              }
              onChange((next) => {
                next.target = value;
                // Switching what a condition looks at must not also change how
                // it compares. Reverting a blank condition to RE2 would widen an
                // `exact` tool name such as `deploy.prod` into a pattern that
                // also matches `deployXprod` — an authorization the user never
                // expressed. An explicitly chosen regex or glob is likewise left
                // alone; only the non-argument cleanup below rewrites a pattern,
                // and an `argument` target keeps whatever was typed.
                if (value !== 'argument') {
                  next.pattern = patternText(next.pattern);
                  delete next.path;
                  delete next.multi;
                }
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
        {isTypedExact ? (
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
            isTypedExact={isTypedExact}
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

      <div className="arb:flex arb:items-center arb:justify-between arb:pt-1">
        <label className="arb:flex arb:cursor-pointer arb:items-center arb:gap-1.5 arb:text-xs arb:text-primary">
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
        <InlineDeleteConditionButton
          index={props.index}
          isArmed={props.isArmed}
          onArm={props.onArm}
          onDisarm={props.onDisarm}
          onRemove={props.onRemove}
        />
      </div>
    </div>
  );
}

/**
 * Which value this condition actually checks.
 *
 * A command or tool condition compares one whole value, so saying "no field
 * selected" is a fact about its reach rather than a missing setting. An argument
 * condition compares whatever its JSONPath selects, so the selector itself is
 * the field and is worth repeating outside the input.
 */
function ConditionFieldNote(props: {
  readonly condition: MutableRuleCondition;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition } = props;
  const path = condition.path?.trim() ?? '';
  return (
    <p
      role="note"
      data-condition-field={
        condition.target === 'argument' ? path || 'unset' : 'whole'
      }
      className="arb:m-0 arb:text-[11.5px] arb:text-tertiary"
    >
      {condition.target === 'argument'
        ? path.length === 0
          ? t('rules.conditionFieldUnsetPath')
          : t('rules.conditionFieldPath', { path })
        : t('rules.conditionFieldWhole', {
            target: t(TARGET_LABEL_KEYS[condition.target]),
          })}
    </p>
  );
}

function InlineDeleteConditionButton(props: {
  readonly index: number;
  readonly isArmed?: boolean | undefined;
  readonly onArm?: (() => void) | undefined;
  readonly onDisarm?: (() => void) | undefined;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const [localArmed, setLocalArmed] = useState(false);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const isControlled = props.isArmed !== undefined;
  const isArmed = isControlled ? props.isArmed : localArmed;

  const onDisarmRef = useRef(props.onDisarm);
  onDisarmRef.current = props.onDisarm;

  const handleArm = () => {
    if (props.onArm) props.onArm();
    else setLocalArmed(true);
  };

  useEffect(() => {
    if (!isArmed) return;

    const disarm = () => {
      if (onDisarmRef.current) onDisarmRef.current();
      else setLocalArmed(false);
    };

    const timer = window.setTimeout(disarm, 3000);

    const handlePointerDown = (event: PointerEvent) => {
      if (
        buttonRef.current &&
        event.target instanceof Node &&
        !buttonRef.current.contains(event.target)
      ) {
        disarm();
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        disarm();
      }
    };

    document.addEventListener('pointerdown', handlePointerDown, true);
    document.addEventListener('keydown', handleKeyDown);

    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', handlePointerDown, true);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isArmed]);

  if (isArmed) {
    return (
      <button
        ref={buttonRef}
        type="button"
        data-confirming="true"
        aria-label={t('rules.confirmDeleteCondition', {
          index: props.index + 1,
        })}
        onClick={props.onRemove}
        className="arb:inline-flex arb:h-7 arb:items-center arb:gap-1.5 arb:rounded arb:border arb:border-error arb:bg-error arb:px-2 arb:text-xs arb:font-medium arb:text-white arb:shadow-xs arb:transition-colors arb:hover:bg-error/90 arb:focus-visible:outline-none arb:focus-visible:ring-1 arb:focus-visible:ring-error"
      >
        <Trash2 className="arb:h-3.5 arb:w-3.5" />
        <span>{t('rules.confirmDeleteShort')}</span>
      </button>
    );
  }

  return (
    <IconButton
      ref={buttonRef}
      label={t('rules.removeCondition')}
      icon={Trash2}
      className="arb:h-7 arb:border arb:border-border-default arb:bg-layer-3 arb:text-error arb:transition-colors hover:arb:border-error/40 hover:arb:bg-error/10"
      onClick={handleArm}
    />
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
  readonly isTypedExact: boolean;
  readonly type: ValueType;
  readonly pendingType: PendingExactType | null;
  readonly condition: MutableRuleCondition;
  readonly onCommitType: () => void;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { isTypedExact, condition, onChange, onCommitType } = props;

  if (!isTypedExact) {
    return (
      <TextInput
        ariaLabel={t('rules.pattern')}
        value={patternText(condition.pattern)}
        onChange={(value) => {
          onChange((next) => {
            next.pattern = value;
          });
        }}
      />
    );
  }

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
