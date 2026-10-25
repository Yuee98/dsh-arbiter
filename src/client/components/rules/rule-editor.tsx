import { useState } from 'react';
import type { ReactNode } from 'react';

import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import { issueText } from '../../view-issues.js';
import { Button, TextInput } from '../controls.js';
import {
  addCondition,
  listText,
  listValue,
  ruleFieldLabel,
  withCondition,
} from './draft.js';
import type { RuleIssue } from './draft.js';
import type { DraftRule } from '../../view-types.js';
import { RuleConditionEditor } from './rule-condition.js';

const groupStyle = {
  display: 'flex',
  flexDirection: 'column',
  gap: 10,
} as const;

const headingStyle = {
  margin: 0,
  fontSize: 12.5,
  fontWeight: 600,
} as const;

const labelStyle = {
  display: 'flex',
  flexDirection: 'column' as const,
  gap: 4,
  fontSize: 12,
  color: 'var(--dsw-alias-label-secondary)',
};

/**
 * The expanded rule body.
 *
 * The header keeps the switch and the verdict dropdown, so this area never
 * repeats them. It owns only the scope, the OR condition list, the note and the
 * optional review hint. Every field is a draft edit; nothing is applied here.
 */
export function RuleEditor(props: {
  readonly rule: DraftRule;
  readonly issues: readonly RuleIssue[];
  readonly onChange: (mutator: (rule: DraftRule) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { rule, onChange, issues } = props;
  return (
    <div style={groupStyle}>
      <p
        style={{
          margin: 0,
          fontSize: 11.5,
          color: 'var(--dsw-alias-label-tertiary)',
        }}
      >
        {t('rules.idDetail', { id: rule.id })}
      </p>

      <ScopeFields rule={rule} onChange={onChange} />

      <section style={groupStyle} aria-label={t('rules.conditions')}>
        <h4 style={headingStyle}>{t('rules.anyOf')}</h4>
        {rule.conditions.length === 0 ? (
          <p
            role="note"
            style={{
              margin: 0,
              fontSize: 12,
              color: 'var(--dsw-alias-state-error-primary)',
            }}
          >
            {t('rules.conditionsEmpty')}
          </p>
        ) : null}
        {rule.conditions.map((condition, conditionIndex) => (
          <RuleConditionEditor
            key={`condition-${String(conditionIndex)}`}
            index={conditionIndex}
            condition={condition}
            onChange={(mutator) => {
              onChange((next) => {
                withCondition(next.conditions, conditionIndex, mutator);
              });
            }}
            onRemove={() => {
              onChange((next) => {
                next.conditions.splice(conditionIndex, 1);
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

      <label style={labelStyle}>
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

      <details>
        <summary
          style={{
            cursor: 'pointer',
            fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)',
          }}
        >
          {t('rules.advanced')}
        </summary>
        <label style={{ ...labelStyle, marginTop: 8 }}>
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
          <span
            style={{ fontSize: 11.5, color: 'var(--dsw-alias-label-tertiary)' }}
          >
            {t('rules.hintHint')}
          </span>
        </label>
      </details>

      <RuleIssueList issues={issues} t={t} />
    </div>
  );
}

/**
 * A comma-separated scope list.
 *
 * The visible text is local while the field is being edited, so typing
 * `bash, deploy` is not rewritten after the first comma. The draft is updated
 * from the same text on every keystroke; blur restores the canonical rendering
 * of whatever the draft actually holds (for example after `bash, ,` is typed).
 */
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
    <section style={groupStyle} aria-label={t('rules.scopeTitle')}>
      <h4 style={headingStyle}>{t('rules.scopeTitle')}</h4>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        <label style={{ ...labelStyle, flex: 1, minWidth: 200 }}>
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
        <label style={{ ...labelStyle, flex: 1, minWidth: 200 }}>
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
        // Show what the draft actually holds once the field is not focused.
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
    <div role="status" style={{ ...groupStyle, gap: 6 }}>
      <h4 style={headingStyle}>{props.t('rules.issues')}</h4>
      {props.issues.map(({ issue, field, severity }, position) => (
        <p
          key={`${severity}-${String(position)}`}
          data-rule-issue={severity}
          data-rule-field={ruleFieldLabel(field)}
          style={{
            margin: 0,
            fontSize: 12,
            color:
              severity === 'error'
                ? 'var(--dsw-alias-state-error-primary)'
                : 'var(--dsw-alias-label-secondary)',
          }}
        >
          {issueText(issue, props.t)}
        </p>
      ))}
    </div>
  );
}
