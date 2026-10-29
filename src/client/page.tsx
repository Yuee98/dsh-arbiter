import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, postJson } from './api.js';
import { ConfigActions } from './components/config-actions.js';
import type { SaveStatus } from './components/config-actions.js';
import { Notice } from './components/controls.js';
import { PageTabs } from './components/page-tabs.js';
import type { TabId } from './components/page-tabs.js';
import {
  clearRulePendingExact,
  pendingExactIssues,
  rebasePendingExactOnRemoveCondition,
  setPendingExactType,
} from './components/rules/draft.js';
import type {
  PendingExactType,
  PendingExactTypeMap,
} from './components/rules/draft.js';
import { ArbiterPortalProvider } from './components/ui/portal-context.js';
import type { RuleCallSource } from './components/rules/rule-from-call-model.js';
import { useRulesPanelCall } from './components/rules/rule-from-call-state.js';
import { saveResponse, validationResponse } from './decoders/state.js';
import { useCoexistenceFeed } from './coexistence-feed.js';
import { useArbiterTranslation } from './i18n-provider.js';
import { reportFindings, useLoadState } from './page-load.js';
import type { ValidationState } from './page-load.js';
import { AboutPanel } from './panels/about.js';
import { AdvancedPanel } from './panels/advanced.js';
import { LogsPanel } from './panels/logs.js';
import { ReviewerPanel } from './panels/reviewer.js';
import { RulesPanel } from './panels/rules.js';
import { StatusPanel } from './panels/status.js';
import { cloneDraft, configErrors, errorText } from './view-helpers.js';
import { issuesText } from './view-issues.js';
import type { ConfigIssueView } from './view-issues.js';
import type {
  Draft,
  SaveResponse,
  SlotProps,
  StateResponse,
} from './view-types.js';

interface SaveFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function draftErrors(payload: unknown): readonly ConfigIssueView[] {
  return configErrors(payload);
}

function failureOf(error: unknown): SaveFailure {
  if (error instanceof ApiError) {
    return { status: error.status, code: error.code, message: error.message };
  }
  return {
    status: 0,
    code: 'request-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

function usePendingExactState(
  onDraft: (mutator: (draft: Draft) => void) => void,
) {
  const [pendingExactTypes, setPendingExactTypes] =
    useState<PendingExactTypeMap>({});

  const handlePendingTypeChange = useCallback(
    (ruleId: string, conditionIndex: number, type: PendingExactType | null) => {
      setPendingExactTypes((current) =>
        setPendingExactType(current, ruleId, conditionIndex, type),
      );
    },
    [],
  );

  const handleRemoveCondition = useCallback(
    (ruleId: string, conditionIndex: number) => {
      setPendingExactTypes((current) =>
        rebasePendingExactOnRemoveCondition(current, ruleId, conditionIndex),
      );
    },
    [],
  );

  const handleDeleteRule = useCallback(
    (ruleId: string) => {
      setPendingExactTypes((current) => clearRulePendingExact(current, ruleId));
      onDraft((d) => {
        const at = d.rules.findIndex((candidate) => candidate.id === ruleId);
        if (at >= 0) d.rules.splice(at, 1);
      });
    },
    [onDraft],
  );

  return {
    pendingExactTypes,
    setPendingExactTypes,
    handlePendingTypeChange,
    handleRemoveCondition,
    handleDeleteRule,
  };
}

function useConfigValidation(props: {
  readonly draft: Draft | null;
  readonly pendingExactTypes: PendingExactTypeMap;
  readonly validationRevision: React.MutableRefObject<number>;
  readonly setValidation: React.Dispatch<React.SetStateAction<ValidationState>>;
  readonly setError: (msg: string | null) => void;
}) {
  const t = useArbiterTranslation();
  const {
    draft,
    pendingExactTypes,
    validationRevision,
    setValidation,
    setError,
  } = props;

  return useCallback(async (): Promise<void> => {
    if (draft === null) return;
    const revision = validationRevision.current;
    const incompleteIssues = pendingExactIssues(
      draft,
      pendingExactTypes,
      t('rules.incompleteExactValue'),
    );
    if (incompleteIssues.length > 0) {
      setValidation((current) =>
        reportFindings(current.sourceWarnings, {
          errors: incompleteIssues,
          warnings: [],
        }),
      );
      return;
    }

    try {
      const response = await postJson(
        '/validate',
        { config: draft },
        validationResponse,
      );
      if (validationRevision.current !== revision) return;
      setValidation((current) =>
        reportFindings(current.sourceWarnings, {
          errors: response.errors,
          warnings: response.warnings,
        }),
      );
    } catch (errorValue) {
      setError(errorText(errorValue));
    }
  }, [
    draft,
    pendingExactTypes,
    setError,
    setValidation,
    t,
    validationRevision,
  ]);
}

export function ArbiterPage(_props: SlotProps): ReactNode {
  const t = useArbiterTranslation();
  const [state, setState] = useState<StateResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [portalContainer, setPortalContainer] = useState<HTMLElement | null>(
    null,
  );
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<TabId>('status');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [auditNotice, setAuditNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<ValidationState>({
    errors: [],
    warnings: [],
    sourceWarnings: [],
  });
  /**
   * The rule-draft call state, owned by the page rather than the rules panel.
   *
   * A tab switch unmounts the panel, and a rule built from a call must keep its
   * recorded call across that — otherwise going to look at the log and coming
   * back would silently retarget the later test at a default sample. The page's
   * transient state survives tab navigation and still resets on a reload, so
   * this is not persisted provenance.
   */
  const ruleCalls = useRulesPanelCall();
  const createRuleFromCall = useCallback(
    (source: RuleCallSource): void => {
      // The open detail asked for a draft: open the same dialog its own import
      // would, and switch to the tab that shows it.
      ruleCalls.pickSource(source);
      setTab('rules');
    },
    [ruleCalls],
  );
  const generation = useRef(0);
  const validationRevision = useRef(0);
  const onFailure = useCallback((failure: unknown): void => {
    setError(errorText(failure));
  }, []);
  const coexistence = useCoexistenceFeed(state, onFailure);

  const onDraft = useCallback((mutator: (draft: Draft) => void): void => {
    validationRevision.current += 1;
    setValidation((current) =>
      reportFindings(current.sourceWarnings, { errors: [], warnings: [] }),
    );
    setDraft((current) => {
      if (current === null) return current;
      const next = cloneDraft(current);
      mutator(next);
      setDirty(true);
      return next;
    });
  }, []);

  const {
    pendingExactTypes,
    setPendingExactTypes,
    handlePendingTypeChange,
    handleRemoveCondition,
    handleDeleteRule,
  } = usePendingExactState(onDraft);

  const setDraftFromLoad = useCallback(
    (action: React.SetStateAction<Draft | null>) => {
      setDraft(action);
      setPendingExactTypes({});
    },
    [setPendingExactTypes],
  );

  const load = useLoadState({
    generation,
    validationRevision,
    setBusy,
    setError,
    setState,
    setDraft: setDraftFromLoad,
    setDirty,
    setSaveStatus,
    setAuditNotice,
    setValidation,
  });

  useEffect(() => {
    load().catch(onFailure);
  }, [load, onFailure]);

  const validate = useConfigValidation({
    draft,
    pendingExactTypes,
    validationRevision,
    setValidation,
    setError,
  });

  const save = useCallback(async (): Promise<void> => {
    if (state === null || draft === null) return;
    const revision = validationRevision.current;
    const incompleteIssues = pendingExactIssues(
      draft,
      pendingExactTypes,
      t('rules.incompleteExactValue'),
    );
    if (incompleteIssues.length > 0) {
      setSaveStatus('failed');
      setValidation((current) => ({ ...current, errors: incompleteIssues }));
      setError(
        t('config.invalid', { errors: issuesText(incompleteIssues, t) }),
      );
      return;
    }

    setBusy(true);
    setError(null);
    setNotice(null);
    setSaveStatus('idle');
    setAuditNotice(null);
    try {
      const response = await postJson<SaveResponse>(
        '/config/save',
        { revision: state.fileRevision, config: draft },
        saveResponse,
      );
      await load({ submittedRevision: revision });
      setSaveStatus(response.changed ? 'saved' : 'unchanged');
      setAuditNotice(
        response.auditError === null
          ? null
          : t('config.auditDegraded', { error: response.auditError }),
      );
    } catch (errorValue) {
      const failure = failureOf(errorValue);
      setSaveStatus('failed');
      if (failure.status === 409 && failure.code === 'config-conflict') {
        setNotice(t('config.conflict'));
        return;
      }
      if (failure.status === 422 && failure.code === 'config-invalid') {
        const errors = draftErrors(
          errorValue instanceof ApiError ? errorValue.payload : null,
        );
        if (validationRevision.current === revision) {
          setValidation((current) => ({ ...current, errors }));
        }
        setError(t('config.invalid', { errors: issuesText(errors, t) }));
        return;
      }
      setError(t('config.rejected', { error: failure.message }));
    } finally {
      setBusy(false);
    }
  }, [draft, load, pendingExactTypes, state, t]);

  if (state === null || draft === null) {
    return (
      <div className="arb:p-6 arb:text-sm arb:text-secondary">
        {error === null
          ? t('config.loading')
          : t('config.loadFailed', { error })}
      </div>
    );
  }

  return (
    <ArbiterPortalProvider container={portalContainer}>
      <div data-arbiter-root="" className="arb:flex arb:flex-col arb:gap-4">
        <div ref={setPortalContainer} data-arbiter-portal-root="" />

        <ConfigActions
          fileRevision={state.fileRevision}
          effectiveRevision={state.effectiveRevision}
          snapshotId={state.configSnapshotId}
          format={state.configFormat}
          formatExplicit={state.configFormatExplicit}
          documentPath={state.documentPath}
          dirty={dirty}
          busy={busy}
          canSave={state.fileRevision !== null}
          status={saveStatus}
          auditNotice={auditNotice}
          onValidate={() => {
            validate().catch(onFailure);
          }}
          onReload={() => {
            load().catch(onFailure);
          }}
          onSave={() => {
            save().catch(onFailure);
          }}
        />

        <PageTabs tab={tab} onTab={setTab} />

        <PageNotices error={error} notice={notice} validation={validation} />

        <PageTabBody
          tab={tab}
          state={state}
          coexistenceView={coexistence.view}
          draft={draft}
          validation={validation}
          pendingExactTypes={pendingExactTypes}
          onDraft={onDraft}
          ruleCalls={ruleCalls}
          onCreateRule={createRuleFromCall}
          onPendingTypeChange={handlePendingTypeChange}
          onRemoveCondition={handleRemoveCondition}
          onDeleteRule={handleDeleteRule}
        />
      </div>
    </ArbiterPortalProvider>
  );
}

function PageNotices(props: {
  readonly error: string | null;
  readonly notice: string | null;
  readonly validation: ValidationState;
}): ReactNode {
  const t = useArbiterTranslation();
  const { error, notice, validation } = props;
  return (
    <>
      {error === null ? null : <Notice kind="error" text={error} />}
      {notice === null ? null : <Notice kind="ok" text={notice} />}
      {validation.errors.length === 0 ? null : (
        <Notice kind="error" text={issuesText(validation.errors, t)} />
      )}
      {validation.warnings.length === 0 ? null : (
        <Notice kind="info" text={issuesText(validation.warnings, t)} />
      )}
    </>
  );
}

function PageTabBody(props: {
  readonly tab: TabId;
  readonly state: StateResponse;
  readonly coexistenceView: ReturnType<typeof useCoexistenceFeed>['view'];
  readonly draft: Draft;
  readonly validation: ValidationState;
  readonly pendingExactTypes: PendingExactTypeMap;
  readonly onDraft: (mutator: (draft: Draft) => void) => void;
  readonly onPendingTypeChange: (
    ruleId: string,
    conditionIndex: number,
    type: PendingExactType | null,
  ) => void;
  readonly onRemoveCondition: (ruleId: string, conditionIndex: number) => void;
  readonly onDeleteRule: (ruleId: string) => void;
  readonly onCreateRule: (source: RuleCallSource) => void;
  readonly ruleCalls: ReturnType<typeof useRulesPanelCall>;
}): ReactNode {
  const {
    tab,
    state,
    coexistenceView,
    draft,
    validation,
    pendingExactTypes,
    onDraft,
    onPendingTypeChange,
    onRemoveCondition,
    onDeleteRule,
    onCreateRule,
    ruleCalls,
  } = props;

  if (tab === 'status') {
    return (
      <StatusPanel
        state={{ ...state, coexistence: coexistenceView }}
        draft={draft}
        onDraft={onDraft}
      />
    );
  }
  if (tab === 'rules') {
    return (
      <RulesPanel
        draft={draft}
        onDraft={onDraft}
        errors={validation.errors}
        warnings={validation.warnings}
        pendingExactTypes={pendingExactTypes}
        onPendingTypeChange={onPendingTypeChange}
        onRemoveCondition={onRemoveCondition}
        onDeleteRule={onDeleteRule}
        calls={ruleCalls}
      />
    );
  }
  if (tab === 'reviewer') {
    return <ReviewerPanel draft={draft} onDraft={onDraft} />;
  }
  if (tab === 'advanced') {
    return <AdvancedPanel draft={draft} onDraft={onDraft} />;
  }
  if (tab === 'logs') {
    return <LogsPanel onCreateRule={onCreateRule} />;
  }
  return <AboutPanel state={state} />;
}
