import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';

import type { DraftRule, RulesPanelProps } from '../view-types.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import { Button, Section } from '../components/controls.js';
import { RuleList } from '../components/rules/rule-list.js';
import { RuleTest } from '../components/rules/rule-test.js';
import { addRule, nextRuleId } from '../components/rules/draft.js';
import { focusConditionField } from '../components/rules/rule-issue-locate.js';
import type { LocateRequest } from '../components/rules/rule-issue-locate.js';

/**
 * Rule management: the list, the inline editor and the tester entry.
 *
 * The panel owns only view state — which row is open and which rule a test
 * action focused. The draft and its mutator come from the page, so the tester
 * reads the same unsaved draft and a later issue can replace its body without
 * touching the list.
 */
export function RulesPanel(props: RulesPanelProps): ReactNode {
  const t = useArbiterTranslation();
  const { draft, onDraft } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [locateRequest, setLocateRequest] = useState<LocateRequest>({
    ruleId: null,
    conditionIndex: null,
    nonce: 0,
  });

  // A row is identified by its stable id, so reordering keeps it open; only
  // removing the rule clears the selection.
  useEffect(() => {
    if (
      selectedId !== null &&
      !draft.rules.some((rule) => rule.id === selectedId)
    )
      setSelectedId(null);
  }, [draft.rules, selectedId]);

  const focusedRule: DraftRule | null =
    draft.rules.find((rule) => rule.id === focusedId) ?? null;

  // Selecting the rule expands its editor; this puts the caret in the field the
  // rejected issue actually names. It runs after the expanded body is rendered,
  // and only reads the editor's own row and accessible labels.
  useEffect(() => {
    if (locateRequest.nonce === 0) return;
    focusConditionField(locateRequest, {
      condition: (index) => t('rules.conditionIndex', { index: index + 1 }),
      jsonPath: t('rules.jsonPath'),
    });
  }, [locateRequest, t]);

  return (
    <>
      <Section title={t('rules.title')} description={t('rules.description')}>
        <div style={{ display: 'flex', gap: 8 }}>
          <Button
            onClick={() => {
              const id = nextRuleId(draft.rules);
              onDraft((next) => {
                addRule(next);
              });
              setSelectedId(id);
            }}
          >
            {t('rules.add')}
          </Button>
        </div>
        <RuleList
          draft={draft}
          selectedId={selectedId}
          {...(props.errors === undefined ? {} : { errors: props.errors })}
          {...(props.warnings === undefined
            ? {}
            : { warnings: props.warnings })}
          onSelect={setSelectedId}
          onDraft={onDraft}
          onTest={(id) => {
            setFocusedId(id);
            setFocusRequest((current) => current + 1);
          }}
        />
        <p
          style={{
            margin: 0,
            color: 'var(--dsw-alias-label-tertiary)',
            fontSize: 11.5,
          }}
        >
          {t('rules.syntax')}
        </p>
      </Section>

      <RuleTest
        draft={draft}
        focusedRule={focusedRule}
        focusRequest={focusRequest}
        // A rejected selector names its rule by stable id, resolved when the
        // error arrived, so a later insert or reorder cannot retarget it.
        // Selecting the rule expands its editor, which owns the condition
        // fields and their focus.
        onLocateIssue={(target) => {
          if (target.ruleId === null) return;
          setSelectedId(target.ruleId);
          setLocateRequest({
            ruleId: target.ruleId,
            conditionIndex: target.conditionIndex,
            nonce: locateRequest.nonce + 1,
          });
        }}
      />
    </>
  );
}
