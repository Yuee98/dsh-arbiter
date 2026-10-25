import { stateResponse, validationResponse } from './decoders/state.js';
import { PageTabs } from './components/page-tabs.js';
import type { TabId } from './components/page-tabs.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, getJson, postJson } from './api.js';
import { ConfigActions } from './components/config-actions.js';
import { Notice } from './components/controls.js';
import { useArbiterTranslation } from './i18n-provider.js';
import { cloneDraft, configErrors, errorText } from './view-helpers.js';
import type { Draft, StateResponse, SlotProps } from './view-types.js';
import type { ConfigError, ConfigWarning } from '../types.js';
import { StatusPanel } from './panels/status.js';
import { RulesPanel } from './panels/rules.js';
import { ReviewerPanel } from './panels/reviewer.js';
import { AdvancedPanel } from './panels/advanced.js';
import { LogsPanel } from './panels/logs.js';
import { AboutPanel } from './panels/about.js';

export function ArbiterPage(_props: SlotProps): ReactNode {
  const t = useArbiterTranslation();
  const [state, setState] = useState<StateResponse | null>(null);
  const [draft, setDraft] = useState<Draft | null>(null);
  const [dirty, setDirty] = useState(false);
  const [tab, setTab] = useState<TabId>('status');
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [validation, setValidation] = useState<{
    readonly errors: readonly ConfigError[];
    readonly warnings: readonly ConfigWarning[];
  }>({ errors: [], warnings: [] });
  const generation = useRef(0);
  const onFailure = useCallback((failure: unknown): void => {
    setError(errorText(failure));
  }, []);

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

  const save = async (): Promise<void> => {
    if (state === null || draft === null) return;
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await postJson('/config/save', {
        revision: state.fileRevision,
        config: draft,
      });
      setNotice(t('config.saved'));
      await load();
    } catch (errorValue) {
      setError(errorText(errorValue));
      if (errorValue instanceof ApiError && errorValue.status === 409) {
        setNotice(t('page.conflict'));
      }
      if (errorValue instanceof ApiError && errorValue.status === 422) {
        const payload = errorValue.payload;
        if (payload !== null && typeof payload === 'object') {
          const errors = configErrors(payload);
          setValidation((current) => ({ ...current, errors }));
        }
      }
    } finally {
      setBusy(false);
    }
  };

  const publicKey = useMemo(
    () => (state === null ? '' : state.effectiveRevision),
    [state],
  );

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
        revision={publicKey}
        documentPath={state.documentPath}
        dirty={dirty}
        busy={busy}
        canSave={state.fileRevision !== null}
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
        <Notice
          kind="error"
          text={validation.errors
            .map((item) => `${item.path}: ${item.message}`)
            .join('\n')}
        />
      )}
      {validation.warnings.length === 0 ? null : (
        <Notice
          kind="info"
          text={validation.warnings
            .map((item) => `${item.path}: ${item.message}`)
            .join('\n')}
        />
      )}

      {tab === 'status' ? (
        <StatusPanel state={state} draft={draft} onDraft={onDraft} />
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
