import { useState } from 'react';
import type { ReactNode } from 'react';
import { isStructuralTarget } from '../../../types.js';
import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { DraftRule } from '../../view-types.js';
import { issueText } from '../../view-issues.js';
import { Button, Select, TextInput } from '../controls.js';
import { cn } from '../ui/cn.js';
import {
  addCondition,
  listText,
  listValue,
  pendingExactKey,
  removeCondition,
  ruleFieldLabel,
  withCondition,
} from './draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
  RuleIssue,
} from './draft.js';
import { RuleConditionEditor } from './rule-condition.js';

function crossesStructuralTargets(rule: DraftRule): boolean {
  const targets = new Set(
    rule.conditions
      .map((condition) => condition.target)
      .filter((target) => isStructuralTarget(target)),
  );
  return targets.size > 1;
}

export function RuleEditor(props: {
  readonly rule: DraftRule;
  readonly issues: readonly RuleIssue[];
  readonly pendingExactTypes?: PendingExactTypeMap | undefined;
  readonly onPendingTypeChange?:
    | ((
        ruleId: string,
        conditionIndex: number,
        type: PendingExactType | null,
      ) => void)
    | undefined;
  readonly onRemoveCondition?:
    ((ruleId: string, conditionIndex: number) => void) | undefined;
  readonly onChange: (mutator: (rule: DraftRule) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const {
    rule,
    onChange,
    issues,
    pendingExactTypes,
    onPendingTypeChange,
    onRemoveCondition,
  } = props;

  return (
    <div className="arb:flex arb:flex-col arb:gap-3">
      <p className="arb:m-0 arb:text-xs arb:text-tertiary">
        {t('rules.idDetail', { id: rule.id })}
      </p>

      <ScopeFields rule={rule} onChange={onChange} />

      <section
        className="arb:flex arb:flex-col arb:gap-2.5"
        aria-label={t('rules.conditions')}
      >
        <h4 className="arb:m-0 arb:text-xs arb:font-semibold arb:text-primary">
          {rule.conditions.length > 1
            ? t('rules.combineHeading')
            : t('rules.oneConditionHeading')}
        </h4>
        {rule.conditions.length > 1 ? (
          <Select
            ariaLabel={t('rules.combine')}
            value={rule.combine ?? 'all'}
            options={['all', 'any'] as const}
            labels={{
              all: t('rules.combineOption.all'),
              any: t('rules.combineOption.any'),
            }}
            onChange={(value) => {
              onChange((next) => {
                next.combine = value;
              });
            }}
          />
        ) : null}
        {rule.conditions.length > 1 &&
        (rule.combine ?? 'all') === 'all' &&
        crossesStructuralTargets(rule) ? (
          <p role="note" className="arb:m-0 arb:text-xs arb:text-tertiary">
            {t('rules.combineCrossTarget')}
          </p>
        ) : null}
        {rule.conditions.length === 0 ? (
          <p role="note" className="arb:m-0 arb:text-xs arb:text-error">
            {t('rules.conditionsEmpty')}
          </p>
        ) : null}
        {rule.conditions.map((condition, conditionIndex) => (
          <RuleConditionEditor
            key={`condition-${String(conditionIndex)}`}
            index={conditionIndex}
            condition={condition}
            pendingType={
              pendingExactTypes?.[pendingExactKey(rule.id, conditionIndex)] ??
              null
            }
            onPendingTypeChange={(nextType) => {
              onPendingTypeChange?.(rule.id, conditionIndex, nextType);
            }}
            onChange={(mutator) => {
              onChange((next) => {
                withCondition(next.conditions, conditionIndex, mutator);
              });
            }}
            onRemove={() => {
              onRemoveCondition?.(rule.id, conditionIndex);
              onChange((next) => {
                removeCondition(next.conditions, conditionIndex);
              });
            }}
          />
        ))}
        <div>
          <Button
            onClick={() => {
              onChange((next) => {
                addCondition(next.conditions);
              });
            }}
          >
            {t('rules.addCondition')}
          </Button>
        </div>
      </section>

      <label className="arb:flex arb:flex-col arb:gap-1 arb:text-xs arb:text-secondary">
        <span>{t('rules.comment')}</span>
        <TextInput
          ariaLabel={t('rules.comment')}
          value={rule.comment ?? ''}
          placeholder={t('rules.commentPlaceholder')}
          onChange={(value) => {
            onChange((next) => {
              if (value.length === 0) delete next.comment;
              else next.comment = value;
            });
          }}
        />
      </label>

      {/* Flatten hint in RuleEditor without details/summary */}
      <label className="arb:flex arb:flex-col arb:gap-1 arb:text-xs arb:text-secondary">
        <span>{t('rules.hint')}</span>
        <TextInput
          ariaLabel={t('rules.hint')}
          value={rule.hint ?? ''}
          onChange={(value) => {
            onChange((next) => {
              if (value.length === 0) delete next.hint;
              else next.hint = value;
            });
          }}
        />
        <span className="arb:text-[11.5px] arb:text-tertiary">
          {t('rules.hintHint')}
        </span>
      </label>

      <RuleIssueList issues={issues} t={t} />
    </div>
  );
}

function ScopeFields(props: {
  readonly rule: DraftRule;
  readonly onChange: (mutator: (rule: DraftRule) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { rule, onChange } = props;

  function setList(field: 'tools' | 'agents', value: string): void {
    onChange((next) => {
      const entries = listValue(value);
      const tools = field === 'tools' ? entries : (next.scope?.tools ?? []);
      const agents = field === 'agents' ? entries : (next.scope?.agents ?? []);
      if (tools.length === 0 && agents.length === 0) {
        delete next.scope;
        return;
      }
      next.scope = {
        ...(tools.length === 0 ? {} : { tools }),
        ...(agents.length === 0 ? {} : { agents }),
      };
    });
  }

  return (
    <section
      className="arb:flex arb:flex-col arb:gap-2"
      aria-label={t('rules.scopeTitle')}
    >
      <h4 className="arb:m-0 arb:text-xs arb:font-semibold arb:text-primary">
        {t('rules.scopeTitle')}
      </h4>
      <div className="arb:flex arb:flex-wrap arb:gap-2.5">
        <label className="arb:flex arb:min-w-[180px] arb:flex-1 arb:flex-col arb:gap-1 arb:text-xs arb:text-secondary">
          <span>{t('rules.tools')}</span>
          <ListField
            ariaLabel={t('rules.tools')}
            value={rule.scope?.tools}
            placeholder={t('rules.toolsPlaceholder')}
            onChange={(value) => {
              setList('tools', value);
            }}
          />
        </label>
        <label className="arb:flex arb:min-w-[180px] arb:flex-1 arb:flex-col arb:gap-1 arb:text-xs arb:text-secondary">
          <span>{t('rules.agents')}</span>
          <ListField
            ariaLabel={t('rules.agents')}
            value={rule.scope?.agents}
            placeholder={t('rules.agentsPlaceholder')}
            onChange={(value) => {
              setList('agents', value);
            }}
          />
        </label>
      </div>
    </section>
  );
}

function ListField(props: {
  readonly ariaLabel: string;
  readonly value: readonly string[] | undefined;
  readonly placeholder: string;
  readonly onChange: (value: string) => void;
}): ReactNode {
  const [editing, setEditing] = useState<string | null>(null);

  return (
    <TextInput
      ariaLabel={props.ariaLabel}
      value={editing ?? listText(props.value)}
      placeholder={props.placeholder}
      monospace
      onChange={(value) => {
        setEditing(value);
        props.onChange(value);
      }}
      onBlur={() => {
        setEditing(null);
      }}
    />
  );
}

function RuleIssueList(props: {
  readonly issues: readonly RuleIssue[];
  readonly t: Translate;
}): ReactNode {
  if (props.issues.length === 0) return null;

  return (
    <div role="status" className="arb:flex arb:flex-col arb:gap-1.5">
      <h4 className="arb:m-0 arb:text-xs arb:font-semibold arb:text-primary">
        {props.t('rules.issues')}
      </h4>
      {props.issues.map(({ issue, field, severity }, position) => (
        <p
          key={`${severity}-${String(position)}`}
          data-rule-issue={severity}
          data-rule-field={ruleFieldLabel(field)}
          className={cn(
            'arb:m-0 arb:text-xs',
            severity === 'error' ? 'arb:text-error' : 'arb:text-secondary',
          )}
        >
          {issueText(issue, props.t)}
        </p>
      ))}
    </div>
  );
}
