import type { ReactNode } from 'react';

import type { RuleKind, RuleTarget } from '../../../types.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { Button, Select, TextInput } from '../controls.js';
import { convertExactPattern, exactType, patternText } from './draft.js';
import type { MutableRuleCondition } from './draft.js';

const TARGETS: readonly RuleTarget[] = [
  'command',
  'file_redirect',
  'variable_assignment',
  'tool',
  'argument',
];
const KINDS: readonly RuleKind[] = ['exact', 'regex', 'glob'];
const VALUE_TYPES = ['string', 'number', 'boolean', 'null'] as const;

const labelStyle = {
  color: 'var(--dsw-alias-label-secondary)',
  fontSize: 11.5,
} as const;

const rowStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 4,
  minWidth: 120,
};

/**
 * One condition.
 *
 * The condition always shows its explicit object, because that choice decides
 * the rest of the form: only the tool-argument object takes a JSONPath and a
 * multi-value mode, and only an exact pattern keeps a JSON type.
 */
export function RuleConditionEditor(props: {
  readonly index: number;
  readonly total: number;
  readonly condition: MutableRuleCondition;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
  readonly onRemove: () => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition, onChange } = props;
  const isArgument = condition.target === 'argument';
  const isExact = condition.kind === 'exact';
  return (
    <div
      role="group"
      aria-label={t('rules.conditionIndex', { index: props.index + 1 })}
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        padding: '10px 12px',
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ ...rowStyle, width: 150 }}>
          <span style={labelStyle}>{t('rules.target')}</span>
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
                // With no expression yet, the target's own default mode applies:
                // a command is whole-value RE2, a selected argument is exact.
                if (patternText(next.pattern).length === 0)
                  next.kind = value === 'argument' ? 'exact' : 'regex';
                // `path` and `multi` belong to the argument target only. A target
                // change drops them rather than leaving an invalid combination.
                if (value === 'argument') return;
                delete next.path;
                delete next.multi;
              });
            }}
          />
        </div>
        <div style={{ ...rowStyle, width: 130 }}>
          <span style={labelStyle}>{t('rules.kind')}</span>
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
              onChange((next) => {
                next.kind = value;
                // RE2 and glob read text; an exact number/boolean/null has no
                // equivalent expression, so its JSON spelling becomes the text.
                if (value !== 'exact' && typeof next.pattern !== 'string')
                  next.pattern = patternText(next.pattern);
              });
            }}
          />
        </div>
        {isArgument ? (
          <div style={{ ...rowStyle, flex: 1, minWidth: 220 }}>
            <span style={labelStyle}>{t('rules.jsonPath')}</span>
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
          <div style={{ ...rowStyle, width: 110 }}>
            <span style={labelStyle}>{t('rules.multi')}</span>
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

      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {isExact ? (
          <div style={{ ...rowStyle, width: 110 }}>
            <span style={labelStyle}>{t('rules.valueType')}</span>
            <Select
              ariaLabel={t('rules.valueType')}
              value={exactType(condition.pattern)}
              options={VALUE_TYPES}
              labels={{
                string: t('rules.valueTypeOption.string'),
                number: t('rules.valueTypeOption.number'),
                boolean: t('rules.valueTypeOption.boolean'),
                null: t('rules.valueTypeOption.null'),
              }}
              onChange={(value) => {
                onChange((next) => {
                  next.pattern = convertExactPattern(next.pattern, value);
                });
              }}
            />
          </div>
        ) : null}
        <div style={{ ...rowStyle, flex: 1, minWidth: 240 }}>
          <span style={labelStyle}>{t('rules.pattern')}</span>
          <ExactValue condition={condition} onChange={onChange} />
        </div>
      </div>

      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <label
          style={{
            display: 'flex',
            gap: 6,
            alignItems: 'center',
            fontSize: 12,
          }}
        >
          <input
            type="checkbox"
            checked={condition.caseSensitive === false}
            onChange={(event) => {
              onChange((next) => {
                // Absence of the field is the confirmed default: sensitive.
                if (event.target.checked) next.caseSensitive = false;
                else delete next.caseSensitive;
              });
            }}
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

/** The pattern editor; an exact `null` is a value rather than an empty input. */
function ExactValue(props: {
  readonly condition: MutableRuleCondition;
  readonly onChange: (
    mutator: (condition: MutableRuleCondition) => void,
  ) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { condition, onChange } = props;
  const type = condition.kind === 'exact' ? exactType(condition.pattern) : null;
  if (type === 'null') {
    return (
      <div
        style={{
          ...labelStyle,
          lineHeight: '30px',
        }}
      >
        {t('rules.valueTypeOption.null')}
      </div>
    );
  }
  if (type === 'boolean') {
    return (
      <Select
        ariaLabel={t('rules.pattern')}
        value={condition.pattern === true ? 'true' : 'false'}
        options={['true', 'false'] as const}
        onChange={(value) => {
          onChange((next) => {
            next.pattern = value === 'true';
          });
        }}
      />
    );
  }
  if (type === 'number') {
    return (
      <input
        type="number"
        aria-label={t('rules.pattern')}
        value={patternText(condition.pattern)}
        onChange={(event) => {
          const parsed = Number(event.target.value);
          if (event.target.value.length === 0 || !Number.isFinite(parsed))
            return;
          onChange((next) => {
            next.pattern = parsed;
          });
        }}
        style={{
          boxSizing: 'border-box',
          height: 30,
          border: '0.5px solid var(--dsw-alias-border-l4)',
          borderRadius: 6,
          background: 'var(--dsw-alias-bg-layer-3)',
          color: 'var(--dsw-alias-label-primary)',
          padding: '0 8px',
          fontSize: 12.5,
          width: '100%',
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
