/**
 * Reading the host state, and what the page learns from it.
 *
 * The loader is the only place that replaces the draft and the only place that
 * replaces the findings about the document on disk. Keeping it in its own module
 * makes that ownership explicit: a draft edit can invalidate a draft finding, but
 * nothing except a reload may drop a warning about a file that is still
 * uncorrected.
 */

import { useCallback } from 'react';
import type { MutableRefObject } from 'react';

import { getJson } from './api.js';
import { stateResponse } from './decoders/state.js';
import { cloneDraft, errorText } from './view-helpers.js';
import type { ConfigIssueView } from './view-issues.js';
import type { SaveStatus } from './components/config-actions.js';
import type { Draft } from './view-types.js';

/** What the page currently reports about the configuration. */
export interface ValidationState {
  readonly errors: readonly ConfigIssueView[];
  readonly warnings: readonly ConfigIssueView[];
  /**
   * Warnings the loaded document produced.
   *
   * Kept apart from the findings about the draft because the two have different
   * lifetimes: the draft changes on every keystroke, the file on disk does not.
   */
  readonly sourceWarnings: readonly ConfigIssueView[];
}

/**
 * Combine the file's own findings with the ones just produced for the draft.
 *
 * `warnings` is what the page displays, so the file's unresolved problems stay in
 * it. A caller that produced no findings still reports the source warnings.
 */
export function reportFindings(
  sourceWarnings: readonly ConfigIssueView[],
  own: {
    readonly errors: readonly ConfigIssueView[];
    readonly warnings: readonly ConfigIssueView[];
  },
): ValidationState {
  return {
    errors: own.errors,
    warnings: [...sourceWarnings, ...own.warnings],
    sourceWarnings,
  };
}

/** The state setters the loader drives; one object keeps the signature short. */
export interface LoadStateSetters {
  readonly generation: MutableRefObject<number>;
  readonly validationRevision: MutableRefObject<number>;
  readonly setBusy: (busy: boolean) => void;
  readonly setError: (message: string | null) => void;
  readonly setState: (value: Awaited<ReturnType<typeof stateResponse>>) => void;
  readonly setDraft: (draft: Draft) => void;
  readonly setDirty: (dirty: boolean) => void;
  readonly setSaveStatus: (status: SaveStatus) => void;
  readonly setAuditNotice: (notice: string | null) => void;
  readonly setValidation: (
    update: (current: ValidationState) => ValidationState,
  ) => void;
}

/**
 * Read the host state.
 *
 * When a save initiated the reload, the submitted draft revision travels with it:
 * the decision to keep or replace the draft is made after `/state` resolves,
 * immediately before the draft is written, so edits made during either the save
 * or the reload survive.
 */
export function useLoadState(
  setters: LoadStateSetters,
): (options?: { readonly submittedRevision?: number }) => Promise<void> {
  const {
    generation,
    validationRevision,
    setBusy,
    setError,
    setState,
    setDraft,
    setDirty,
    setSaveStatus,
    setAuditNotice,
    setValidation,
  } = setters;
  return useCallback(
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
        // A reload or a completed save replaces the draft, so any answer for the
        // previous draft is stale from here on.
        const edited = validationRevision.current !== options.submittedRevision;
        validationRevision.current += 1;
        setState(value);
        if (options.submittedRevision !== undefined && edited) {
          // The user edited after submitting the save. The applied configuration
          // is what was sent; the newer edits stay unsaved. The file itself did
          // change, though, so its findings come from this answer rather than
          // from the previous document — a warning about a field the save
          // removed must not outlive the save.
          setValidation(() =>
            reportFindings(value.warnings, { errors: [], warnings: [] }),
          );
          return;
        }
        setDraft(cloneDraft(value.config));
        setDirty(false);
        setSaveStatus('idle');
        setAuditNotice(null);
        // A reload is the one event that replaces the file's own findings.
        // `loadErrors` are configuration errors: they belong to the error
        // presentation only, never to the non-blocking warning list.
        setValidation(() =>
          reportFindings(value.warnings, {
            errors: value.loadErrors,
            warnings: [],
          }),
        );
      } catch (errorValue) {
        if (generation.current === ticket) setError(errorText(errorValue));
      } finally {
        if (generation.current === ticket) setBusy(false);
      }
    },
    [
      generation,
      validationRevision,
      setBusy,
      setError,
      setState,
      setDraft,
      setDirty,
      setSaveStatus,
      setAuditNotice,
      setValidation,
    ],
  );
}
