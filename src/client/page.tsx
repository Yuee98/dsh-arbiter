import {
  saveResponse,
  stateResponse,
  validationResponse,
} from './decoders/state.js';
import { PageTabs } from './components/page-tabs.js';
import type { TabId } from './components/page-tabs.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, getJson, postJson } from './api.js';
import { CoexistenceAlert } from './components/coexistence.js';
import { useCoexistenceFeed } from './coexistence-feed.js';
import { ConfigActions } from './components/config-actions.js';
import type { SaveStatus } from './components/config-actions.js';
import { Notice } from './components/controls.js';
import { useArbiterTranslation } from './i18n-provider.js';
import { cloneDraft, configErrors, errorText } from './view-helpers.js';
import { issuesText } from './view-issues.js';
import type { ConfigIssueView } from './view-issues.js';
import type {
  CoexistenceView,
  Draft,
  SaveResponse,
  StateResponse,
  SlotProps,
} from './view-types.js';
import { StatusPanel } from './panels/status.js';
import { RulesPanel } from './panels/rules.js';
import { ReviewerPanel } from './panels/reviewer.js';
import { AdvancedPanel } from './panels/advanced.js';
import { LogsPanel } from './panels/logs.js';
import { AboutPanel } from './panels/about.js';

interface SaveFailure {
  readonly status: number;
  readonly code: string;
  readonly message: string;
}

function draftErrors(payload: unknown): readonly ConfigIssueView[] {
  return configErrors(payload);
}

function failureOf(error: unknown): SaveFailure {
  if (error instanceof ApiError)
    return { status: error.status, code: error.code, message: error.message };
  return {
    status: 0,
    code: 'request-failed',
    message: error instanceof Error ? error.message : String(error),
  };
}

/** The payload's own coexistence section, the feed's starting value. */
function initialCoexistence(
  state: StateResponse | null,
): CoexistenceView | null {
  return state === null ? null : state.coexistence;
}

export function ArbiterPage(_props: SlotProps): ReactNode {
  const t = useArbiterTranslation();
  const [state, setState] = useState<StateResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<TabId>('status');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>('idle');
  const [auditNotice, setAuditNotice] = useState<string | null>(null);
  const [validation, setValidation] = useState<{
    readonly errors: readonly ConfigIssueView[];
    readonly warnings: readonly ConfigIssueView[];
  }>({ errors: [], warnings: [] });
  const generation = useRef(0);
  const onFailure = useCallback((failure: unknown): void => {
    setError(errorText(failure));
  }, []);
  // The feed owns the live coexistence view; the payload's own value is only
  // the initial one, so a conflict found while the page is open still shows.
  const coexistenceFeed = useCoexistenceFeed(
    initialCoexistence(state),
    onFailure,
  );

  const load = useCallback(async (): Promise<void> => {
    const ticket = generation.current + 1;
    generation.current = ticket;
    setBusy(true);
    setError(null);
    try {
      const value = await getJson('/state', stateResponse);
      if (generation.current !== ticket) return;
      setState(value);
      setDraft(cloneDraft(value.config));
      setDirty(false);
      setSaveStatus('idle');
      setAuditNotice(null);
      setValidation({ errors: value.loadErrors, warnings: value.warnings });
    } catch (errorValue) {
      if (generation.current === ticket) setError(errorText(errorValue));
    } finally {
      if (generation.current === ticket) setBusy(false);
    }
  }, []);

  useEffect(() => {
    load().catch(onFailure);
  }, [load, onFailure]);

  const onDraft = useCallback((mutator: (draft: Draft) => void): void => {
    setDraft((current) => {
      if (current === null) return current;
      const next = cloneDraft(current);
      mutator(next);
      setDirty(true);
      return next;
    });
  }, []);

  const validate = useCallback(async (): Promise<void> => {
    if (draft === null) return;
    try {
      const response = await postJson(
        '/validate',
        { config: draft },
        validationResponse,
      );
      setValidation({ errors: response.errors, warnings: response.warnings });
    } catch (errorValue) {
      setError(errorText(errorValue));
    }
  }, [draft]);

  const save = useCallback(async (): Promise<void> => {
    if (state === null || draft === null) return;
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
      // Reload first: the reload clears transient state, so the saved-and-
      // effective feedback is published after the fresh identities arrive.
      await load();
      // Saved and effective are reported separately: the API only returns this
      // payload after the candidate was written and applied.
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
        // The draft is kept: the user merges it against the changed file.
        setNotice(t('config.conflict'));
        return;
      }
      if (failure.status === 422 && failure.code === 'config-invalid') {
        const errors = draftErrors(
          errorValue instanceof ApiError ? errorValue.payload : null,
        );
        setValidation((current) => ({ ...current, errors }));
        setError(t('config.invalid', { errors: issuesText(errors, t) }));
        return;
      }
      setError(t('config.rejected', { error: failure.message }));
    } finally {
      setBusy(false);
    }
  }, [draft, load, state, t]);

  if (state === null || draft === null) {
    return (
      <div
        style={{
          padding: 24,
          fontSize: 13,
          color: 'var(--dsw-alias-label-secondary)',
        }}
      >
        {error === null
          ? t('config.loading')
          : t('config.loadFailed', { error })}
      </div>
    );
  }

  return (
    <div
      data-arbiter-root
      style={{ display: 'flex', flexDirection: 'column', gap: 16 }}
    >
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

      <CoexistenceAlert
        coexistence={coexistenceFeed.view}
        onAcknowledge={coexistenceFeed.acknowledge}
      />

      <PageTabs tab={tab} onTab={setTab} />

      {error === null ? null : <Notice kind="error" text={error} />}
      {notice === null ? null : <Notice kind="ok" text={notice} />}
      {validation.errors.length === 0 ? null : (
        <Notice kind="error" text={issuesText(validation.errors, t)} />
      )}
      {validation.warnings.length === 0 ? null : (
        <Notice kind="info" text={issuesText(validation.warnings, t)} />
      )}

      {tab === 'status' ? (
        <StatusPanel
          state={{ ...state, coexistence: coexistenceFeed.view }}
          draft={draft}
          onDraft={onDraft}
        />
      ) : null}
      {tab === 'rules' ? <RulesPanel draft={draft} onDraft={onDraft} /> : null}
      {tab === 'reviewer' ? (
        <ReviewerPanel draft={draft} onDraft={onDraft} />
      ) : null}
      {tab === 'advanced' ? (
        <AdvancedPanel draft={draft} onDraft={onDraft} />
      ) : null}
      {tab === 'logs' ? <LogsPanel /> : null}
      {tab === 'about' ? <AboutPanel state={state} /> : null}
    </div>
  );
}
