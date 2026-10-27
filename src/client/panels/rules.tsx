import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section } from '../components/controls.js';
import { addRule, nextRuleId } from '../components/rules/draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
} from '../components/rules/draft.js';
import { focusConditionField } from '../components/rules/rule-issue-locate.js';
import type { LocateRequest } from '../components/rules/rule-issue-locate.js';
import { RuleList } from '../components/rules/rule-list.js';
import { RuleTest } from '../components/rules/rule-test.js';
import { useArbiterTranslation } from '../i18n-provider.js';
import type { DraftRule, RulesPanelProps } from '../view-types.js';

export interface ExtendedRulesPanelProps extends RulesPanelProps {
  readonly pendingExactTypes?: PendingExactTypeMap;
  readonly onPendingTypeChange?: (
    ruleId: string,
    conditionIndex: number,
    type: PendingExactType | null,
  ) => void;
  readonly onRemoveCondition?: (ruleId: string, conditionIndex: number) => void;
  readonly onDeleteRule?: (ruleId: string) => void;
}

export function RulesPanel(props: ExtendedRulesPanelProps): ReactNode {
  const t = useArbiterTranslation();
  const {
    draft,
    onDraft,
    pendingExactTypes,
    onPendingTypeChange,
    onRemoveCondition,
    onDeleteRule,
  } = props;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [focusRequest, setFocusRequest] = useState(0);
  const [locateRequest, setLocateRequest] = useState<LocateRequest>({
    ruleId: null,
    conditionIndex: null,
    nonce: 0,
  });

  useEffect(() => {
    if (
      selectedId !== null &&
      !draft.rules.some((rule) => rule.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [draft.rules, selectedId]);

  const focusedRule: DraftRule | null =
    draft.rules.find((rule) => rule.id === focusedId) ?? null;

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
        <div className="arb:flex arb:items-center arb:gap-2">
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
          <Button
            onClick={() => {
              setFocusedId(null);
              setFocusRequest((current) => current + 1);
            }}
          >
            {t('ruleTest.open')}
          </Button>
        </div>
        <RuleList
          draft={draft}
          selectedId={selectedId}
          {...(props.errors === undefined ? {} : { errors: props.errors })}
          {...(props.warnings === undefined
            ? {}
            : { warnings: props.warnings })}
          pendingExactTypes={pendingExactTypes}
          onSelect={setSelectedId}
          onDraft={onDraft}
          onTest={(id) => {
            setFocusedId(id);
            setFocusRequest((current) => current + 1);
          }}
          onPendingTypeChange={onPendingTypeChange}
          onRemoveCondition={onRemoveCondition}
          onDeleteRule={onDeleteRule}
        />
        <p className="arb:m-0 arb:text-xs arb:text-tertiary">
          {t('rules.syntax')}
        </p>
      </Section>

      <RuleTest
        draft={draft}
        focusedRule={focusedRule}
        focusRequest={focusRequest}
        renderTrigger={false}
        onClearFocus={() => {
          setFocusedId(null);
        }}
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
