import { useId } from 'react';
import type { ReactNode } from 'react';

import type { Translate } from '../../i18n.js';
import { useArbiterTranslation } from '../../i18n-provider.js';
import type { Draft, DraftRule, RuleListProps } from '../../view-types.js';
import { Select, TextInput } from '../controls.js';
import {
  VERDICT_LABEL_KEY,
  VERDICT_ORDER,
  addDuplicate,
  canMoveRule,
  moveRule,
  ruleIssues,
  ruleName,
  ruleSummary,
  withRule,
} from './draft.js';
import type { RuleIssue } from './draft.js';
import { RuleEditor } from './rule-editor.js';

const headerStyle = {
  display: 'flex',
  alignItems: 'center',
  gap: 8,
  padding: '8px 10px',
  flexWrap: 'wrap',
} as const;

/** A glyph-only control keeps the header compact; its name carries the label. */
const RESTORE_NAME_GLYPH = '↺';

const iconButtonStyle = {
  height: 28,
  padding: '0 10px',
  borderRadius: 6,
  fontSize: 12,
  cursor: 'pointer',
  border: '0.5px solid var(--dsw-alias-border-l4)',
  background: 'var(--dsw-alias-bg-layer-2)',
  color: 'var(--dsw-alias-label-primary)',
} as const;

/**
 * The rule list.
 *
 * A row header is the fixed contract from the design: switch, name, verdict
 * dropdown, test, edit/collapse and more. The inline body never repeats the
 * switch or the verdict. The body reads from the same draft, so collapsing a
 * row and opening it again keeps every edit.
 */
export function RuleList(props: RuleListProps): ReactNode {
  const t = useArbiterTranslation();
  const { draft, selectedId, onSelect, onDraft, onTest } = props;
  if (draft.rules.length === 0) {
    return (
      <p
        style={{
          margin: 0,
          fontSize: 12.5,
          color: 'var(--dsw-alias-label-tertiary)',
        }}
      >
        {t('rules.empty')}
      </p>
    );
  }
  return (
    <ul
      aria-label={t('rules.title')}
      style={{ margin: 0, padding: 0, listStyle: 'none' }}
    >
      {draft.rules.map((rule, index) => (
        <RuleRow
          key={rule.id}
          rule={rule}
          index={index}
          rules={draft.rules}
          issues={ruleIssuesOf(rule, index, props)}
          expanded={selectedId === rule.id}
          onSelect={onSelect}
          onDraft={onDraft}
          onTest={onTest}
        />
      ))}
    </ul>
  );
}

function ruleIssuesOf(
  rule: DraftRule,
  index: number,
  props: RuleListProps,
): readonly RuleIssue[] {
  return [
    ...ruleIssues(
      (props.errors ?? []).map((issue) => ({
        issue,
        field: issue.path,
        severity: 'error' as const,
      })),
      rule,
      index,
    ),
    ...ruleIssues(
      (props.warnings ?? []).map((issue) => ({
        issue,
        field: issue.path,
        severity: 'warning' as const,
      })),
      rule,
      index,
    ),
  ];
}

function RuleRow(props: {
  readonly rule: DraftRule;
  readonly index: number;
  readonly rules: readonly DraftRule[];
  readonly issues: readonly RuleIssue[];
  readonly expanded: boolean;
  readonly onSelect: (id: string | null) => void;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly onTest: (id: string) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const bodyId = useId();
  const { rule, index, expanded, onSelect, onDraft, onTest } = props;
  const name = ruleName(rule, t);
  const summary = ruleSummary(rule, t);
  const hasError = props.issues.some((issue) => issue.severity === 'error');
  const update = (mutator: (next: DraftRule) => void): void => {
    onDraft((draft) => {
      withRule(draft, rule.id, mutator);
    });
  };
  return (
    <li
      data-rule-row={rule.id}
      data-rule-verdict={rule.verdict}
      style={{
        border: '0.5px solid var(--dsw-alias-border-l2)',
        borderRadius: 8,
        marginBottom: 8,
        background: 'var(--dsw-alias-bg-layer-2)',
      }}
    >
      <div style={headerStyle}>
        <input
          type="checkbox"
          aria-label={t('rules.enabledRule', { name })}
          checked={rule.enabled !== false}
          onChange={(event) => {
            update((next) => {
              next.enabled = event.target.checked;
            });
          }}
        />
        <div
          style={{
            display: 'flex',
            flex: 1,
            minWidth: 200,
            alignItems: 'center',
            gap: 6,
          }}
        >
          <div
            style={{ flex: 1 }}
            title={`${summary}\n${t('rules.nameTitle')}`}
          >
            <TextInput
              ariaLabel={t('rules.name')}
              value={rule.name ?? ''}
              placeholder={summary}
              onChange={(value) => {
                update((next) => {
                  // An empty name means "use the automatic summary"; the field
                  // is dropped rather than storing a blank string, which the
                  // backend rejects as an empty custom name.
                  if (value.trim().length === 0) delete next.name;
                  else next.name = value;
                });
              }}
            />
          </div>
          {rule.name === undefined ? null : (
            <button
              type="button"
              aria-label={t('rules.restoreName')}
              title={t('rules.restoreName')}
              style={iconButtonStyle}
              onClick={() => {
                update((next) => {
                  delete next.name;
                });
              }}
            >
              {RESTORE_NAME_GLYPH}
            </button>
          )}
        </div>
        <div style={{ width: 150 }}>
          <Select
            ariaLabel={t('rules.verdictRule', { name })}
            value={rule.verdict}
            options={VERDICT_ORDER}
            labels={verdictLabels(t)}
            onChange={(value) => {
              update((next) => {
                next.verdict = value;
              });
            }}
          />
        </div>
        <button
          type="button"
          style={iconButtonStyle}
          title={summary}
          onClick={() => {
            onTest(rule.id);
          }}
        >
          {t('rules.test')}
        </button>
        <button
          type="button"
          style={iconButtonStyle}
          aria-expanded={expanded}
          aria-controls={bodyId}
          aria-label={
            expanded
              ? t('rules.collapseRule', { name })
              : t('rules.editRule', { name })
          }
          onClick={() => {
            onSelect(expanded ? null : rule.id);
          }}
        >
          {expanded ? t('rules.collapse') : t('rules.edit')}
        </button>
        <MoreMenu
          rule={rule}
          rules={props.rules}
          index={index}
          onDraft={onDraft}
        />
      </div>
      {hasError || rule.enabled === false ? (
        <div
          style={{
            padding: '0 10px 6px',
            fontSize: 11.5,
            color: hasError
              ? 'var(--dsw-alias-state-error-primary)'
              : 'var(--dsw-alias-label-tertiary)',
          }}
        >
          {hasError ? t('rules.hasErrors') : t('rules.disabled')}
        </div>
      ) : null}
      {expanded ? (
        <div
          id={bodyId}
          style={{
            borderTop: '0.5px solid var(--dsw-alias-border-l2)',
            padding: '12px 14px',
          }}
        >
          <RuleEditor rule={rule} issues={props.issues} onChange={update} />
        </div>
      ) : null}
    </li>
  );
}

function verdictLabels(t: Translate): Readonly<Record<string, string>> {
  const labels: Record<string, string> = {};
  for (const verdict of VERDICT_ORDER)
    labels[verdict] = t(VERDICT_LABEL_KEY[verdict]);
  return labels;
}

/**
 * Duplicate, delete and reorder.
 *
 * A move only swaps with a neighbour of the same verdict, so ordering never
 * changes which priority a rule competes in.
 */
function MoreMenu(props: {
  readonly rule: DraftRule;
  readonly rules: readonly DraftRule[];
  readonly index: number;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
}): ReactNode {
  const t = useArbiterTranslation();
  const { rule, rules, index, onDraft } = props;
  const move = (direction: -1 | 1): void => {
    onDraft((draft) => {
      moveRule(draft.rules, index, direction);
    });
  };
  return (
    <details>
      <summary
        aria-label={t('rules.moreRule', { name: ruleName(rule, t) })}
        style={{
          ...iconButtonStyle,
          listStyle: 'none',
          display: 'inline-flex',
          alignItems: 'center',
        }}
      >
        {t('rules.more')}
      </summary>
      <div
        role="group"
        aria-label={t('rules.more')}
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 4,
          padding: '4px 0',
        }}
      >
        <button
          type="button"
          style={iconButtonStyle}
          onClick={() => {
            onDraft((draft) => {
              addDuplicate(draft, rule);
            });
          }}
        >
          {t('rules.duplicate')}
        </button>
        <button
          type="button"
          style={iconButtonStyle}
          disabled={!canMoveRule(rules, index, -1)}
          onClick={() => {
            move(-1);
          }}
        >
          {t('rules.moveUp')}
        </button>
        <button
          type="button"
          style={iconButtonStyle}
          disabled={!canMoveRule(rules, index, 1)}
          onClick={() => {
            move(1);
          }}
        >
          {t('rules.moveDown')}
        </button>
        <button
          type="button"
          style={{
            ...iconButtonStyle,
            color: 'var(--dsw-alias-state-error-primary)',
          }}
          onClick={() => {
            onDraft((draft) => {
              const at = draft.rules.findIndex(
                (candidate) => candidate.id === rule.id,
              );
              if (at >= 0) draft.rules.splice(at, 1);
            });
          }}
        >
          {t('rules.delete')}
        </button>
      </div>
    </details>
  );
}
