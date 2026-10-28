import { Plus } from 'lucide-react';
import { useState } from 'react';
import type { ReactNode } from 'react';
import { isStructuralTarget } from '../../../types.js';
import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { DraftRule } from '../../view-types.js';
import { issueText } from '../../view-issues.js';
import { Button, RadioGroup, TextInput } from '../controls.js';
import { cn } from '../ui/cn.js';
import {
  VERDICT_BEHAVIOR_KEY,
  addCondition,
  isAdvancedCondition,
  listText,
  listValue,
  pendingExactKey,
  removeCondition,
  ruleFieldLabel,
  scopeLabel,
  scopeView,
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

  const [armedConditionIndex, setArmedConditionIndex] = useState<number | null>(
    null,
  );
  const [lastRuleId, setLastRuleId] = useState(rule.id);
  if (rule.id !== lastRuleId) {
    setLastRuleId(rule.id);
    setArmedConditionIndex(null);
  }

  return (
    <div className="arb:flex arb:flex-col arb:gap-3">
      <p className="arb:m-0 arb:text-xs arb:text-tertiary">
        {t('rules.idDetail', { id: rule.id })}
      </p>

      <BehaviorNote rule={rule} />

      <ScopeFields rule={rule} onChange={onChange} />

      <section
        className="arb:flex arb:flex-col arb:gap-2.5"
        aria-label={t('rules.conditions')}
      >
        {rule.conditions.length > 1 ? (
          <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-3">
            <span className="arb:text-xs arb:font-semibold arb:text-primary">
              {t('rules.combine')}
            </span>
            <RadioGroup
              ariaLabel={t('rules.combine')}
              name={`combine-${rule.id}`}
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
          </div>
        ) : (
          <h4 className="arb:m-0 arb:text-xs arb:font-semibold arb:text-primary">
            {t('rules.oneConditionHeading')}
          </h4>
        )}
        {rule.conditions.length > 1 ? (
          // Adding a condition is the moment the reader has to know what the
          // default does; stating it here costs one line and prevents a rule
          // that silently means "all" from being read as "any".
          <p role="note" className="arb:m-0 arb:text-xs arb:text-tertiary">
            {t('rules.combineDefaultNote')}
          </p>
        ) : null}
        {rule.conditions.length > 1 &&
        (rule.combine ?? 'all') === 'all' &&
        crossesStructuralTargets(rule) ? (
          <p role="note" className="arb:m-0 arb:text-xs arb:text-tertiary">
            {t('rules.combineCrossTarget')}
          </p>
        ) : null}
        {rule.conditions.some(isAdvancedCondition) ? (
          // Naming what is not the plain exact-whole-value form keeps the
          // ordinary form readable without removing any of the capability.
          <p role="note" className="arb:m-0 arb:text-xs arb:text-tertiary">
            {t('rules.advancedConditionNote')}
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
            isArmed={armedConditionIndex === conditionIndex}
            onArm={() => {
              setArmedConditionIndex(conditionIndex);
            }}
            onDisarm={() => {
              setArmedConditionIndex((current) =>
                current === conditionIndex ? null : current,
              );
            }}
            onRemove={() => {
              setArmedConditionIndex(null);
              onRemoveCondition?.(rule.id, conditionIndex);
              onChange((next) => {
                removeCondition(next.conditions, conditionIndex);
              });
            }}
          />
        ))}
        <div>
          <Button
            className="arb:inline-flex arb:items-center arb:gap-1.5"
            onClick={() => {
              setArmedConditionIndex(null);
              onChange((next) => {
                addCondition(next.conditions);
              });
            }}
          >
            <Plus className="arb:h-3.5 arb:w-3.5" />
            <span>{t('rules.addCondition')}</span>
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

      {/* A hint only steers what the reviewer looks at, so it lives with the
          other optional settings rather than beside the ordinary match fields.
          It stays reachable in one click and never blocks forced review. */}
      <details
        data-rule-advanced=""
        className="arb:rounded-md arb:border arb:border-border-subtle arb:p-2.5"
      >
        <summary className="arb:cursor-pointer arb:text-xs arb:font-semibold arb:text-primary">
          {t('rules.advanced')}
        </summary>
        <label className="arb:mt-2 arb:flex arb:flex-col arb:gap-1 arb:text-xs arb:text-secondary">
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
      </details>

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
  const scope = scopeView(rule);

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
      {/* The effective scope is stated, not implied by empty inputs: leaving both
          fields blank means "every tool and every agent", which is the opposite
          of what an empty-looking form suggests. */}
      <p
        role="note"
        data-rule-scope={scope.kind}
        className={cn(
          'arb:m-0 arb:text-xs',
          scope.kind === 'unscoped' ? 'arb:text-secondary' : 'arb:text-primary',
        )}
      >
        {scopeLabel(scope, t)}
      </p>
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

/**
 * What the selected behavior does, and how it relates to the other two layers.
 *
 * The four verdicts are not four severities of the same thing. `deny`,
 * `force-ask` and a covering `allow` are decided without the model at all, while
 * `force-review` always sends the call to it — a distinction the option labels
 * alone cannot carry. The division sentence states once that natural-language
 * policy makes the judgement, a deterministic rule only forces the path, and a
 * hint only steers attention.
 */
function BehaviorNote(props: { readonly rule: DraftRule }): ReactNode {
  const t = useArbiterTranslation();
  return (
    <section
      className="arb:flex arb:flex-col arb:gap-1 arb:rounded-md arb:border arb:border-border-subtle arb:p-2.5"
      aria-label={t('rules.behaviorTitle')}
    >
      <p
        role="note"
        data-rule-behavior={props.rule.verdict}
        className="arb:m-0 arb:text-xs arb:text-primary"
      >
        {t(VERDICT_BEHAVIOR_KEY[props.rule.verdict])}
      </p>
      <p className="arb:m-0 arb:text-[11.5px] arb:text-tertiary">
        {t('rules.verdictDivision')}
      </p>
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
