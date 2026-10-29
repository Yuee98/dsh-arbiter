import { FlaskConical, Plus } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Button, Section } from '../components/controls.js';
import { addRule, adoptRule, nextRuleId } from '../components/rules/draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
} from '../components/rules/draft.js';
import { RuleFromCallDialog } from '../components/rules/rule-from-call.js';
import {
  importedSampleOf,
  ruleCallSource,
} from '../components/rules/rule-from-call-model.js';
import type { RuleCallSource } from '../components/rules/rule-from-call-model.js';
import { useRulesPanelCall } from '../components/rules/rule-from-call-state.js';
import { focusConditionField } from '../components/rules/rule-issue-locate.js';
import type { LocateRequest } from '../components/rules/rule-issue-locate.js';
import { RuleList } from '../components/rules/rule-list.js';
import { RuleTestImport } from '../components/rules/rule-test-import.js';
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
  /**
   * A call another surface asked to turn into a draft, e.g. an open call detail.
   *
   * `nonce` identifies the request: opening the same call twice is two requests.
   * The panel opens its dialog from it and never builds a draft on its own.
   */
  readonly initialCall?: PendingRuleCall | undefined;
  /**
   * Told once a request has been opened.
   *
   * The caller drops it so switching tabs and coming back does not reopen a
   * dialog the user already answered; the request is one action, not a state.
   */
  readonly onConsumeCall?: (() => void) | undefined;
}

/** One request from another surface to open the draft dialog for a call. */
export interface PendingRuleCall {
  readonly nonce: number;
  readonly source: RuleCallSource;
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
  const ruleTestOpenerRef = useRef<HTMLElement | null>(null);
  const [locateRequest, setLocateRequest] = useState<LocateRequest>({
    ruleId: null,
    conditionIndex: null,
    nonce: 0,
  });
  const calls = useRulesPanelCall();
  const { state: callState } = calls;
  const pending = callState.source;
  const initialCall = props.initialCall;

  // Another surface (an open call detail) asked for this call. The nonce makes
  // one request one dialog, so re-opening the same call still shows it again.
  const handledInitial = useRef(0);
  const consumeCall = props.onConsumeCall;
  useEffect(() => {
    if (initialCall === undefined) return;
    if (initialCall.nonce === handledInitial.current) return;
    handledInitial.current = initialCall.nonce;
    calls.pickSource(initialCall.source);
    consumeCall?.();
  }, [initialCall, calls, consumeCall]);

  useEffect(() => {
    if (
      selectedId !== null &&
      !draft.rules.some((rule) => rule.id === selectedId)
    ) {
      setSelectedId(null);
    }
  }, [draft.rules, selectedId]);

  const focusedRule: DraftRule | null =
    draft.rules.find((rule) => rule.id === callState.focusedId) ?? null;

  // A created rule's draft can be discarded without saving, and its id can be
  // reused by the next create. Dropping the seeds of rules that no longer exist
  // keeps a fresh rule from being tested against a call it was never built from.
  const pruneSeeds = calls.pruneSeeds;
  useEffect(() => {
    pruneSeeds(draft.rules.map((rule) => rule.id));
  }, [draft.rules, pruneSeeds]);

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
        <div className="arb:flex arb:flex-wrap arb:items-center arb:gap-2">
          <Button
            onClick={() => {
              const id = nextRuleId(draft.rules);
              onDraft((next) => {
                addRule(next);
              });
              setSelectedId(id);
            }}
          >
            <Plus className="arb:h-3.5 arb:w-3.5" aria-hidden="true" />
            <span>{t('rules.add')}</span>
          </Button>
          <RuleTestImport
            disabled={false}
            triggerLabelKey="rules.fromCallTrigger"
            onImport={(callId, imported) => {
              calls.pickSource(
                ruleCallSource(
                  callId,
                  imported.sample.tool,
                  imported.sample.args,
                  { identity: imported.identity, cwd: imported.cwd },
                ),
              );
            }}
          />
          <Button
            onClick={(event) => {
              ruleTestOpenerRef.current = event.currentTarget;
              calls.focusNone();
            }}
          >
            <FlaskConical className="arb:h-3.5 arb:w-3.5" aria-hidden="true" />
            <span>{t('ruleTest.open')}</span>
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
          onTest={(id, opener) => {
            ruleTestOpenerRef.current = opener ?? null;
            calls.focusRule(id);
          }}
          onPendingTypeChange={onPendingTypeChange}
          onRemoveCondition={onRemoveCondition}
          onDeleteRule={onDeleteRule}
        />
        <p className="arb:m-0 arb:text-xs arb:text-tertiary">
          {t('rules.syntax')}
        </p>
      </Section>

      {pending === null ? null : (
        <RuleFromCallDialog
          source={pending}
          draft={draft}
          onCreate={(rule, test) => {
            onDraft((next) => {
              adoptRule(next, rule);
            });
            setSelectedId(rule.id);
            calls.created(
              rule.id,
              {
                callId: pending.callId,
                imported: importedSampleOf(pending),
              },
              test,
            );
          }}
          onClose={calls.cancelSource}
        />
      )}

      <RuleTest
        draft={draft}
        focusedRule={focusedRule}
        focusRequest={callState.focusRequest}
        openerRef={ruleTestOpenerRef}
        renderTrigger={false}
        {...(callState.activeSeed === null
          ? {}
          : { sampleSeed: callState.activeSeed })}
        onClearFocus={calls.clearFocus}
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
