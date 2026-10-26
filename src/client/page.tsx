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
import { ConfigActions } from './components/config-actions.js';
import type { SaveStatus } from './components/config-actions.js';
import { Notice } from './components/controls.js';
import { useCoexistenceFeed } from './coexistence-feed.js';
import { useArbiterTranslation } from './i18n-provider.js';
import { cloneDraft, configErrors, errorText } from './view-helpers.js';
import { issuesText } from './view-issues.js';
import type { ConfigIssueView } from './view-issues.js';
import type {
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
  /**
   * Findings belong to the draft revision that produced them.
   *
   * Editing invalidates the current revision, and a late `/validate` answer is
   * dropped when its revision is no longer current, so a rule never keeps an
   * error that was reported for different content.
   */
  const validationRevision = useRef(0);
  const onFailure = useCallback((failure: unknown): void => {
    setError(errorText(failure));
  }, []);
  // The feed keeps the conflict view live; the payload's value only seeds it.
  const coexistence = useCoexistenceFeed(state, onFailure);

  /**
   * Read the host state.
   *
   * When a save initiated the reload, the submitted draft revision travels with
   * it: the decision to keep or replace the draft is made after `/state`
   * resolves, immediately before the draft is written, so edits made during
   * either the save or the reload survive.
   */
  const load = useCallback(
    async (
      options: { readonly submittedRevision?: number } = {},
    ): Promise<void> => {
      const ticket = generation.current + 1;
      generation.current = ticket;
      setBusy(true);
      setError(null);
      try {
        const value = await getJson('/state', stateResponse);
        if (generation.current !== ticket) return;
        // A reload or a completed save replaces the draft, so any answer for
        // the previous draft is stale from here on.
        const edited = validationRevision.current !== options.submittedRevision;
        validationRevision.current += 1;
        setState(value);
        if (options.submittedRevision !== undefined && edited) {
          // The user edited after submitting the save. The applied
          // configuration is what was sent; the newer edits stay unsaved.
          setValidation({ errors: [], warnings: [] });
          return;
        }
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
    },
    [],
  );

  useEffect(() => {
    load().catch(onFailure);
  }, [load, onFailure]);

  const onDraft = useCallback((mutator: (draft: Draft) => void): void => {
    validationRevision.current += 1;
    setValidation({ errors: [], warnings: [] });
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
    const revision = validationRevision.current;
    try {
      const response = await postJson(
        '/validate',
        { config: draft },
        validationResponse,
      );
      // A draft edit while the request was in flight makes this answer stale.
      if (validationRevision.current !== revision) return;
      setValidation({ errors: response.errors, warnings: response.warnings });
    } catch (errorValue) {
      setError(errorText(errorValue));
    }
  }, [draft]);

  const save = useCallback(async (): Promise<void> => {
    if (state === null || draft === null) return;
    // Findings from this save belong to the draft submitted here.
    const revision = validationRevision.current;
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
      // effective feedback is published after the fresh identities arrive. A
      // draft edited during the request is preserved instead of discarded.
      await load({ submittedRevision: revision });
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
        // The errors describe the draft that was submitted. If the editor has
        // moved on, they must not be attached to whatever rule now sits at that
        // index; the failure is still reported, without per-rule findings.
        if (validationRevision.current === revision)
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
          state={{ ...state, coexistence: coexistence.view }}
          draft={draft}
          onDraft={onDraft}
        />
      ) : null}
      {tab === 'rules' ? (
        <RulesPanel
          draft={draft}
          onDraft={onDraft}
          errors={validation.errors}
          warnings={validation.warnings}
        />
      ) : null}
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
